import {
  NAME_MATCH_BANDS,
  type KycErrorReason,
  type KycFailureReason,
  type NameMatchBand,
} from '@clowe/shared';
import { cashfreeHost, cashfreeSignature, type CashfreeEnvironment } from '../cashfree/client';
import { KycProviderError, type KycProvider, type KycResult, type NameMatch } from './KycProvider';

export interface CashfreeKycConfig {
  /** The Verification Suite's keys — Cashfree issues separate keys per product. */
  clientId: string;
  clientSecret: string;
  environment: CashfreeEnvironment;
  /** PEM, for accounts on public-key 2FA. Leave out when the server's IP is allowlisted. */
  publicKeyPem?: string;
  /** Per call. */
  timeoutMs?: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Response shapes — only the fields this class reads.
 *
 * Cashfree returns a good deal more: the name registered against the PAN, the
 * account holder's name at the bank, addresses, and (on newer API versions)
 * Aadhaar seeding status. None of it is typed here, on purpose, so none of it
 * can be read, stored or logged by accident. What leaves this class is a
 * verdict, a reason and a score.
 */
interface PanReply {
  valid?: unknown;
  pan_status?: unknown;
  name_match_score?: unknown;
  name_match_result?: unknown;
}
interface GstinReply {
  valid?: unknown;
  gst_in_status?: unknown;
}
interface BankReply {
  account_status?: unknown;
  account_status_code?: unknown;
  name_match_score?: unknown;
  name_match_result?: unknown;
}

type Reply<T> = { ok: true; body: T } | { ok: false; status: number; code: string };

/** 422s from the bank-account API that mean "the bank did not answer", not "no". */
const BANK_SIDE_UNAVAILABLE = new Set([
  'failed_at_bank',
  'npci_unavailable',
  'connection_timeout',
  'source_bank_declined',
  'bene_bank_declined',
  'imps_mode_fail',
  'benficiary_bank_offline', // sic — Cashfree's spelling
]);

/** 400s that are about our account's setup, not about the details sent. */
const CONFIGURATION_CODES = new Set([
  'x-client-id_missing',
  'x-client-secret_value_invalid', // test keys used in production
  'invalid_request', // the product is not enabled on the account
]);

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * KYC verification through Cashfree's Verification Suite (Secure ID).
 *
 *   PAN     POST /verification/pan                { pan, name }
 *   GSTIN   POST /verification/gstin              { GSTIN }
 *   Bank    POST /verification/bank-account/sync  { bank_account, ifsc, name? }
 *
 * One request per call, and never a retry. Each of these is billed, and a
 * request that timed out may still have been served — so a retry can charge
 * twice for one answer. Failures surface as KycProviderError and whoever holds
 * the history decides whether to ask again.
 *
 * There is no credential check at startup, unlike try-on: Cashfree has no
 * free endpoint to probe with, and a wrong key shows up as PROVIDER_AUTH on
 * the first real check anyway.
 */
export class CashfreeKycProvider implements KycProvider {
  readonly name = 'cashfree';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CashfreeKycConfig) {
    this.baseUrl = `${cashfreeHost(config.environment)}/verification`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async verifyPAN(pan: string, name: string): Promise<KycResult> {
    // No x-api-version header: versions after 2022-09-12 add Aadhaar seeding
    // status to this answer, and Clowe does not want or keep Aadhaar data.
    const path = '/pan';
    const reply = await this.post<PanReply>(path, { pan, name: providerName(name) });
    if (!reply.ok) throw this.errorFor(path, reply);

    const { valid, pan_status } = reply.body;
    if (typeof valid !== 'boolean') throw this.malformed(path);
    const status = typeof pan_status === 'string' ? pan_status.toUpperCase() : '';
    if (status === 'DELETED' || status === 'DEACTIVATED') return failed('PAN_INACTIVE');
    if (!valid || (status !== '' && status !== 'VALID')) return failed('PAN_INVALID');
    return { status: 'VERIFIED', reason: null, nameMatch: nameMatchFrom(reply.body) };
  }

  async verifyGSTIN(gstin: string): Promise<KycResult> {
    // business_name is not sent. Cashfree returns no match for it, so it would
    // be sharing the seller's details for nothing.
    const path = '/gstin';
    const reply = await this.post<GstinReply>(path, { GSTIN: gstin });
    if (!reply.ok) throw this.errorFor(path, reply);

    const { valid, gst_in_status } = reply.body;
    if (typeof valid !== 'boolean') throw this.malformed(path);
    if (!valid) return failed('GSTIN_NOT_FOUND');
    const active = typeof gst_in_status === 'string' && gst_in_status.trim().toLowerCase() === 'active';
    return active ? { status: 'VERIFIED', reason: null, nameMatch: null } : failed('GSTIN_INACTIVE');
  }

  async verifyBank(accountNumber: string, ifsc: string, name: string | null): Promise<KycResult> {
    const path = '/bank-account/sync';
    const payload: Record<string, string> = { bank_account: accountNumber, ifsc };
    // The name goes only when the caller asked for a match: the match is billed
    // on top of the verification itself.
    if (name !== null) payload.name = providerName(name);

    const reply = await this.post<BankReply>(path, payload);
    if (!reply.ok) {
      // A fraud-flagged account comes back as a 422, but it is an answer about
      // the account — the most important one — not an outage.
      if (reply.status === 422 && reply.code === 'fraud_account') return failed('FRAUD_ACCOUNT');
      throw this.errorFor(path, reply);
    }

    const { account_status, account_status_code } = reply.body;
    if (typeof account_status !== 'string') throw this.malformed(path);
    if (account_status.toUpperCase() === 'VALID') {
      return {
        status: 'VERIFIED',
        reason: null,
        nameMatch: name === null ? null : nameMatchFrom(reply.body),
      };
    }
    const code = typeof account_status_code === 'string' ? account_status_code.toUpperCase() : '';
    if (code === 'ACCOUNT_BLOCKED') return failed('ACCOUNT_BLOCKED');
    if (code === 'INVALID_IFSC_FAIL') return failed('IFSC_INVALID');
    if (code === 'NRE_ACCOUNT_FAIL') return failed('NRE_ACCOUNT');
    return failed('ACCOUNT_INVALID');
  }

  // -------------------------------------------------------------------------

  private async post<T>(path: string, payload: Record<string, string>): Promise<Reply<T>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-client-id': this.config.clientId,
      'x-client-secret': this.config.clientSecret,
    };
    if (this.config.publicKeyPem) {
      headers['x-cf-signature'] = cashfreeSignature(this.config.clientId, this.config.publicKeyPem);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Timed out or never connected. Deliberately not retried: a request that
      // timed out may still have reached Cashfree, and been billed.
      const kind = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new KycProviderError('NETWORK', `${path}: ${kind}`);
    }

    const body = (await res.json().catch(() => ({}))) as T & { code?: unknown };
    if (res.ok) return { ok: true, body };
    return { ok: false, status: res.status, code: typeof body.code === 'string' ? body.code : '' };
  }

  /**
   * Our reason for a non-2xx reply. The detail line holds the HTTP status and
   * Cashfree's error code and nothing else — its message text can echo the
   * PAN or account number that was sent.
   */
  private errorFor(path: string, reply: { status: number; code: string }): KycProviderError {
    const { status, code } = reply;
    const detail = `${path}: HTTP ${status}${code ? ` ${code}` : ''}`;
    let reason: KycErrorReason;
    if (status === 401 || status === 403) reason = 'PROVIDER_AUTH';
    else if (status === 429) reason = 'PROVIDER_BUSY';
    else if (status === 422 && code === 'insufficient_balance') reason = 'PROVIDER_BALANCE';
    else if (status === 422 && code === 'verification_already_under_process') reason = 'PROVIDER_BUSY';
    else if (status === 422 && BANK_SIDE_UNAVAILABLE.has(code)) reason = 'BANK_UNAVAILABLE';
    else if (status === 400 && CONFIGURATION_CODES.has(code)) reason = 'PROVIDER_AUTH';
    else if (status === 400) reason = 'REQUEST_REJECTED';
    else reason = 'PROVIDER_UNAVAILABLE';
    return new KycProviderError(reason, detail);
  }

  /** A 200 without the verdict field is not an answer; caching it as one would be worse. */
  private malformed(path: string): KycProviderError {
    return new KycProviderError('PROVIDER_UNAVAILABLE', `${path}: HTTP 200 without a verdict`);
  }
}

function failed(reason: KycFailureReason): KycResult {
  return { status: 'FAILED', reason, nameMatch: null };
}

const BANDS = new Set<string>(NAME_MATCH_BANDS);

/**
 * Cashfree's score and band, as given. The score arrives as a string ("90.00");
 * it is only parsed and clamped, never recomputed.
 */
function nameMatchFrom(body: { name_match_score?: unknown; name_match_result?: unknown }): NameMatch | null {
  const raw = body.name_match_score;
  const score = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const band = typeof body.name_match_result === 'string' ? body.name_match_result.toUpperCase() : '';
  if (!Number.isFinite(score) || !BANDS.has(band)) return null;
  return { score: Math.round(Math.min(100, Math.max(0, score))), band: band as NameMatchBand };
}

/**
 * A name in the characters Cashfree accepts — letters, digits, space, . - / & —
 * so "D'Souza" is sent as "D Souza" rather than bounced with a 400 that may
 * still count against the account. Capped at the 100 characters it allows.
 */
function providerName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9 .&/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}
