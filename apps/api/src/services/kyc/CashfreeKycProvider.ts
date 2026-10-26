import {
  NAME_MATCH_BANDS,
  type KycErrorReason,
  type KycFailureReason,
  type NameMatchBand,
} from '@clowe/shared';
import { cashfreeHost, cashfreeSignature, ipv4Fetch, type CashfreeEnvironment } from '../cashfree/client';
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
  reference_id?: unknown;
  valid?: unknown;
  pan_status?: unknown;
  name_match_score?: unknown;
  name_match_result?: unknown;
}
interface GstinReply {
  reference_id?: unknown;
  valid?: unknown;
  gst_in_status?: unknown;
}
interface BankReply {
  reference_id?: unknown;
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
 * There is no credential check at startup, unlike try-on: every probe is a
 * call to Cashfree, and a wrong key shows up as PROVIDER_AUTH on the first
 * real check anyway. checkAuth() exists for a person to run by hand.
 */
export class CashfreeKycProvider implements KycProvider {
  readonly name = 'cashfree';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CashfreeKycConfig) {
    this.baseUrl = `${cashfreeHost(config.environment)}/verification`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Over IPv4: the production allowlist takes IPv4 addresses only.
    this.fetchImpl = config.fetchImpl ?? ipv4Fetch;
  }

  async verifyPAN(pan: string, name: string): Promise<KycResult> {
    // No x-api-version header: versions after 2022-09-12 add Aadhaar seeding
    // status to this answer, and Clowe does not want or keep Aadhaar data.
    const path = '/pan';
    const reply = await this.post<PanReply>(path, { pan, name: providerName(name) });
    if (!reply.ok) throw this.errorFor(path, reply);

    const { valid, pan_status } = reply.body;
    if (typeof valid !== 'boolean') throw this.malformed(path);
    const ref = referenceIdFrom(reply.body);
    const status = typeof pan_status === 'string' ? pan_status.toUpperCase() : '';
    if (status === 'DELETED' || status === 'DEACTIVATED') return failed('PAN_INACTIVE', ref);
    if (!valid || (status !== '' && status !== 'VALID')) return failed('PAN_INVALID', ref);
    return { status: 'VERIFIED', reason: null, nameMatch: nameMatchFrom(reply.body), referenceId: ref };
  }

  async verifyGSTIN(gstin: string): Promise<KycResult> {
    // business_name is not sent. Cashfree returns no match for it, so it would
    // be sharing the seller's details for nothing.
    const path = '/gstin';
    const reply = await this.post<GstinReply>(path, { GSTIN: gstin });
    if (!reply.ok) throw this.errorFor(path, reply);

    const { valid, gst_in_status } = reply.body;
    if (typeof valid !== 'boolean') throw this.malformed(path);
    const ref = referenceIdFrom(reply.body);
    if (!valid) return failed('GSTIN_NOT_FOUND', ref);
    const active = typeof gst_in_status === 'string' && gst_in_status.trim().toLowerCase() === 'active';
    return active ? { status: 'VERIFIED', reason: null, nameMatch: null, referenceId: ref } : failed('GSTIN_INACTIVE', ref);
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
    const ref = referenceIdFrom(reply.body);
    if (account_status.toUpperCase() === 'VALID') {
      return {
        status: 'VERIFIED',
        reason: null,
        nameMatch: name === null ? null : nameMatchFrom(reply.body),
        referenceId: ref,
      };
    }
    const code = typeof account_status_code === 'string' ? account_status_code.toUpperCase() : '';
    if (code === 'ACCOUNT_BLOCKED') return failed('ACCOUNT_BLOCKED', ref);
    if (code === 'INVALID_IFSC_FAIL') return failed('IFSC_INVALID', ref);
    if (code === 'NRE_ACCOUNT_FAIL') return failed('NRE_ACCOUNT', ref);
    return failed('ACCOUNT_INVALID', ref);
  }

  /**
   * Are the keys (and this server's IP) accepted? Asks the status of a bank
   * verification that cannot exist (reference_id 0): no PAN, GSTIN or account
   * is sent and nothing is verified. 401/403 is a no; any other answer — the
   * expected "not found" — means the credentials got through. For a person to
   * run by hand (scripts/cashfreeLiveCheck.ts), never at boot or on a timer.
   */
  async checkAuth(): Promise<{ ok: boolean; status: number; code: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/bank-account?reference_id=0`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, status: 0, code: 'unreachable' };
    }
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    return { ok: res.status !== 401 && res.status !== 403 && res.status < 500, status: res.status, code };
  }

  // -------------------------------------------------------------------------

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'x-client-id': this.config.clientId,
      'x-client-secret': this.config.clientSecret,
    };
    if (this.config.publicKeyPem) {
      headers['x-cf-signature'] = cashfreeSignature(this.config.clientId, this.config.publicKeyPem);
    }
    return headers;
  }

  private async post<T>(path: string, payload: Record<string, string>): Promise<Reply<T>> {
    const headers = { 'content-type': 'application/json', ...this.headers() };

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

function failed(reason: KycFailureReason, referenceId: string | null = null): KycResult {
  return { status: 'FAILED', reason, nameMatch: null, referenceId };
}

/** Cashfree's reference_id (a number on some APIs, a string on others), or null. */
function referenceIdFrom(body: { reference_id?: unknown }): string | null {
  const raw = body.reference_id;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.trim())) return raw.trim();
  return null;
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
