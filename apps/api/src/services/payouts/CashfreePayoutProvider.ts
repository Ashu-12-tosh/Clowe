import {
  cashfreeErrorCode,
  cashfreeHost,
  cashfreeSignature,
  idempotencyKey,
  ipv4Fetch,
  paiseFromRupees,
  rupeesFromPaise,
  type CashfreeEnvironment,
} from '../cashfree/client';
import { GatewayError } from '../payments/PaymentProvider';
import type { PayoutBalance, PayoutBeneficiary, PayoutProvider, PayoutTransfer, PayoutTransferRequest, PayoutVerification } from './PayoutProvider';

/** Payouts v2. */
export const CASHFREE_PAYOUT_API_VERSION = '2024-01-01';

export interface CashfreePayoutConfig {
  clientId: string;
  clientSecret: string;
  environment: CashfreeEnvironment;
  /** PEM, for signature 2FA. Leave out when the server's IP is allowlisted. */
  publicKeyPem?: string;
  baseUrl?: string;
  /** The v1 host (the balance lives only there) — tests only. */
  v1BaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The v1 API's own hosts: the account balance has no v2 endpoint. */
function payoutV1Host(environment: CashfreeEnvironment): string {
  return environment === 'production' ? 'https://payout-api.cashfree.com' : 'https://payout-gamma.cashfree.com';
}

/** Cashfree's transfer_id and beneficiary_id: letters, digits, underscore. */
const PAYOUT_ID = /^[A-Za-z0-9_]{1,40}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

interface TransferBody {
  transfer_id?: unknown;
  cf_transfer_id?: unknown;
  status?: unknown;
  status_code?: unknown;
  status_description?: unknown;
  transfer_utr?: unknown;
  utr?: unknown;
}

/**
 * Cashfree Payouts v2 (/payout, its own keys).
 *
 *   POST /payout/beneficiary              save where money goes (once per account)
 *   POST /payout/transfers                send; transfer_id is ours, fixed per payout
 *   GET  /payout/transfers?transfer_id=…  where it is now
 *   v1:  POST /payout/v1/authorize, GET /payout/v1/getBalance   the account balance (read-only)
 *
 * Production refuses calls from an IP not on the account's allowlist (IPv4
 * only), so every call goes out over IPv4; a server without a fixed IP signs
 * instead (x-cf-signature, CASHFREE_PAYOUT_PUBLIC_KEY).
 *
 * A transfer counts as paid only at status SUCCESS with status_code
 * COMPLETED. A timeout or 5xx is not a failure: the transfer may have been
 * received, so it is reported as an error and the caller asks getTransfer —
 * never sends a new transfer. Sending the same transfer_id again is safe:
 * Cashfree refuses a duplicate.
 */
export class CashfreePayoutProvider implements PayoutProvider {
  readonly name = 'cashfree';
  private readonly baseUrl: string;
  private readonly v1BaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CashfreePayoutConfig) {
    this.baseUrl = `${config.baseUrl ?? cashfreeHost(config.environment)}/payout`;
    this.v1BaseUrl = `${config.v1BaseUrl ?? payoutV1Host(config.environment)}/payout/v1`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? ipv4Fetch;
  }

  async ensureBeneficiary(b: PayoutBeneficiary): Promise<string> {
    if (!PAYOUT_ID.test(b.id)) throw new GatewayError('Beneficiary id is not one Cashfree accepts', 400, 'beneficiary_id_invalid');
    const instrument: Record<string, string> = b.vpa
      ? { vpa: b.vpa }
      : { bank_account_number: b.accountNumber ?? '', bank_ifsc: (b.ifsc ?? '').toUpperCase() };
    const contact: Record<string, string> = {};
    if (b.phone) contact.beneficiary_phone = b.phone.replace(/\D/g, '').slice(-10);
    if (b.email) contact.beneficiary_email = b.email;
    const reply = await this.call(
      'POST',
      '/beneficiary',
      {
        beneficiary_id: b.id,
        beneficiary_name: b.name.replace(/[^A-Za-z0-9 .&'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
        beneficiary_instrument_details: instrument,
        ...(Object.keys(contact).length ? { beneficiary_contact_details: contact } : {}),
      },
      `beneficiary:${b.id}`,
    );
    if (reply.ok) return b.id;
    // 409 means one of two things, and only the first is "done": this id is
    // already saved (a retry) — or this bank account is saved under another id
    // (the seller re-added it, or two of our payout methods share it), and
    // Cashfree refuses a second one. Transferring to our id then fails with
    // "Beneficiary id does not exist", so read back which one it is.
    if (reply.status === 409) {
      if (await this.findBeneficiary({ beneficiary_id: b.id })) return b.id;
      if (!b.vpa && b.accountNumber && b.ifsc) {
        const existing = await this.findBeneficiary({ bank_account_number: b.accountNumber, bank_ifsc: b.ifsc.toUpperCase() });
        if (existing) return existing;
      }
    }
    throw this.error('save beneficiary', reply);
  }

  /** The id of a saved beneficiary matching the query, or null when there is none. */
  private async findBeneficiary(query: Record<string, string>): Promise<string | null> {
    const reply = await this.call('GET', `/beneficiary?${new URLSearchParams(query).toString()}`);
    if (reply.status === 404) return null;
    if (!reply.ok) throw this.error('read beneficiary', reply);
    const body = Array.isArray(reply.body) ? reply.body[0] : reply.body;
    const id = body && typeof body === 'object' ? (body as { beneficiary_id?: unknown }).beneficiary_id : null;
    return typeof id === 'string' && id ? id : null;
  }

  async transfer(request: PayoutTransferRequest): Promise<PayoutTransfer> {
    if (!PAYOUT_ID.test(request.transferId)) throw new GatewayError('Transfer id is not one Cashfree accepts', 400, 'transfer_id_invalid');
    if (!request.beneficiaryId) throw new GatewayError('No beneficiary for this transfer', 400, 'beneficiary_missing');
    const reply = await this.call(
      'POST',
      '/transfers',
      {
        transfer_id: request.transferId,
        transfer_amount: rupeesFromPaise(request.amountPaise),
        transfer_currency: 'INR',
        transfer_mode: request.mode,
        beneficiary_details: { beneficiary_id: request.beneficiaryId },
        transfer_remarks: `Clowe ${request.reference}`.replace(/[^A-Za-z0-9 ]/g, ' ').slice(0, 70),
      },
      `transfer:${request.transferId}`,
    );
    if (reply.ok) return transferFrom(reply.body as TransferBody);
    // The same transfer_id again: it exists, so read where it is.
    if (reply.status === 409) {
      const existing = await this.getTransfer(request.transferId);
      if (existing) return existing;
    }
    // Refused outright (bad beneficiary, insufficient balance…): it never left.
    if (reply.status === 400 || reply.status === 403 || reply.status === 404 || reply.status === 422) {
      return { status: 'FAILED', providerStatus: reply.code || `HTTP_${reply.status}`, failureReason: reply.message || reply.code || 'Transfer refused' };
    }
    throw this.error('transfer', reply);
  }

  async getTransfer(transferId: string): Promise<PayoutTransfer | null> {
    const reply = await this.call('GET', `/transfers?transfer_id=${encodeURIComponent(transferId)}`);
    if (reply.ok) return transferFrom(reply.body as TransferBody);
    if (reply.status === 404) return null;
    throw this.error('get transfer', reply);
  }

  /**
   * The account balance, read-only: a v1 bearer token (valid a few minutes,
   * fetched per call — this is asked rarely), then getBalance. Proves the keys
   * and the IP allowlist work without moving any money. Amounts in paise.
   */
  async getBalance(): Promise<PayoutBalance> {
    const auth = await this.v1('POST', '/authorize', {
      'x-client-id': this.config.clientId,
      'x-client-secret': this.config.clientSecret,
      ...(this.config.publicKeyPem ? { 'x-cf-signature': cashfreeSignature(this.config.clientId, this.config.publicKeyPem) } : {}),
    });
    const token = (auth.data as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !token) throw new GatewayError('Cashfree Payouts authorize returned no token', 502, 'no_token');
    const reply = await this.v1('GET', '/getBalance', { authorization: `Bearer ${token}` });
    const data = (reply.data ?? {}) as { balance?: unknown; availableBalance?: unknown };
    const balancePaise = paiseFromRupees(data.balance);
    const availablePaise = paiseFromRupees(data.availableBalance);
    if (!Number.isFinite(balancePaise) || !Number.isFinite(availablePaise)) throw new GatewayError('Cashfree Payouts balance without amounts', 502, 'malformed');
    return { balancePaise, availablePaise };
  }

  /** Accounts are verified by Secure ID in the KYC flow, not here. */
  async verifyMethod(): Promise<PayoutVerification> {
    return { verified: false, reason: 'Verified through seller KYC' };
  }

  // -------------------------------------------------------------------------

  /**
   * A v1 call. v1 answers HTTP 200 with status "ERROR" (and the real code in
   * subCode) as often as it uses an HTTP error, so both are read.
   */
  private async v1(method: string, path: string, headers: Record<string, string>): Promise<{ data?: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.v1BaseUrl}${path}`, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const kind = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new GatewayError(`Cashfree Payouts ${method} v1${path}: ${kind}`, 0, 'network');
    }
    const body = ((await res.json().catch(() => null)) ?? {}) as { status?: unknown; subCode?: unknown; message?: unknown; data?: unknown };
    const ok = res.ok && (typeof body.status !== 'string' || body.status.toUpperCase() === 'SUCCESS');
    if (ok) return { data: body.data };
    const sub = typeof body.subCode === 'string' && /^\d{3}$/.test(body.subCode) ? Number(body.subCode) : res.status;
    const message = typeof body.message === 'string' ? body.message.slice(0, 200) : '';
    throw new GatewayError(`Cashfree Payouts v1${path} failed (HTTP ${res.status}, subCode ${sub})${message ? `: ${message}` : ''}`, sub, `v1_${sub}`);
  }

  private async call(
    method: string,
    path: string,
    payload?: unknown,
    idempotencySeed?: string,
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; code: string; message: string }> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-version': CASHFREE_PAYOUT_API_VERSION,
      'x-client-id': this.config.clientId,
      'x-client-secret': this.config.clientSecret,
    };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (idempotencySeed) headers['x-request-id'] = idempotencyKey(idempotencySeed);
    if (this.config.publicKeyPem) headers['x-cf-signature'] = cashfreeSignature(this.config.clientId, this.config.publicKeyPem);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const kind = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new GatewayError(`Cashfree Payouts ${method} ${path.split('?')[0]}: ${kind}`, 0, 'network');
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok) return { ok: true, status: res.status, body };
    const message =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message.slice(0, 200)
        : '';
    return { ok: false, status: res.status, code: cashfreeErrorCode(body), message };
  }

  private error(what: string, reply: { status: number; code: string; message: string }): GatewayError {
    return new GatewayError(
      `Cashfree Payouts ${what} failed (HTTP ${reply.status}${reply.code ? ` ${reply.code}` : ''})${reply.message ? `: ${reply.message}` : ''}`,
      reply.status,
      reply.code,
    );
  }
}

function transferFrom(body: TransferBody): PayoutTransfer {
  const status = typeof body.status === 'string' ? body.status.toUpperCase() : '';
  const code = typeof body.status_code === 'string' ? body.status_code.toUpperCase() : '';
  const utrRaw = typeof body.transfer_utr === 'string' ? body.transfer_utr : typeof body.utr === 'string' ? body.utr : '';
  const base = {
    utr: utrRaw.trim() || null,
    providerTransferId: body.cf_transfer_id === undefined || body.cf_transfer_id === null ? null : String(body.cf_transfer_id),
    providerStatus: code ? `${status}/${code}` : status || 'UNKNOWN',
  };
  const description = typeof body.status_description === 'string' ? body.status_description.slice(0, 200) : '';
  if (status === 'SUCCESS' && (code === 'COMPLETED' || code === '')) return { ...base, status: 'PAID' };
  if (status === 'REVERSED') return { ...base, status: 'REVERSED', failureReason: description || 'Reversed by the bank' };
  if (status === 'FAILED' || status === 'REJECTED' || status === 'MANUALLY_REJECTED') {
    return { ...base, status: 'FAILED', failureReason: description || code || status };
  }
  return { ...base, status: 'PROCESSING' };
}
