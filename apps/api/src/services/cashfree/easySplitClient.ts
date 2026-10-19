import { GatewayError } from '../payments/PaymentProvider';
import { CASHFREE_PG_API_VERSION } from '../payments/CashfreePaymentProvider';
import { cashfreeErrorCode, cashfreeHost, idempotencyKey, ipv4Fetch, paiseFromRupees, type CashfreeEnvironment } from './client';

/**
 * Cashfree Easy Split, with the Payment Gateway's keys.
 *
 *   POST /pg/easy-split/vendors                 create a vendor (a seller)
 *   GET  /pg/easy-split/vendors/{vendor_id}     its status (ACTIVE once Cashfree has checked it)
 *   GET  /pg/easy-split/orders/{order_id}       the order's vendor shares and their eligibility dates
 *   PUT  /api/v2/easy-split/orders/{order_id}/settlement-eligibility/vendors/{vendor_id}
 *        bring a deferred share's settlement forward (the older API host and
 *        header style — this call has not moved to /pg). Needs deferred
 *        settlement enabled on the account, or Cashfree answers 400.
 *
 * Deferral itself is an account setting (dashboard: Defer settlement, N days):
 * every vendor share waits N days unless released earlier here.
 */
export interface CashfreeEasySplitConfig {
  clientId: string;
  clientSecret: string;
  environment: CashfreeEnvironment;
  baseUrl?: string;
  legacyBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface VendorInput {
  vendorId: string;
  name: string;
  email: string;
  phone: string;
  bank: { accountNumber: string; accountHolder: string; ifsc: string };
  pan: string;
  gstin?: string | null;
  /** INDIVIDUAL or BUSINESS. */
  accountType: 'INDIVIDUAL' | 'BUSINESS';
  businessType: string;
}

export interface VendorShare {
  vendorId: string;
  amountPaise: number;
  eligibleAt: string | null;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** The older API's host per environment (sandbox: test.cashfree.com). */
function legacyHost(environment: CashfreeEnvironment): string {
  return environment === 'production' ? 'https://api.cashfree.com' : 'https://test.cashfree.com';
}

/** "YYYY-MM-DD HH:mm:ss" in India time, as the eligibility API wants it. */
export function istStamp(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60 * 1000);
  return ist.toISOString().replace('T', ' ').slice(0, 19);
}

export class CashfreeEasySplitClient {
  private readonly baseUrl: string;
  private readonly legacyUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CashfreeEasySplitConfig) {
    this.baseUrl = `${config.baseUrl ?? cashfreeHost(config.environment)}/pg/easy-split`;
    this.legacyUrl = `${config.legacyBaseUrl ?? legacyHost(config.environment)}/api/v2/easy-split`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? ipv4Fetch;
  }

  /** Create the vendor; an existing one (a retry) is read back instead. Returns its status. */
  async createVendor(v: VendorInput): Promise<string> {
    const kyc: Record<string, string> = { account_type: v.accountType, business_type: v.businessType, pan: v.pan };
    if (v.gstin) kyc.gst = v.gstin;
    const reply = await this.call(
      'POST',
      `${this.baseUrl}/vendors`,
      {
        vendor_id: v.vendorId,
        status: 'ACTIVE',
        name: v.name,
        email: v.email,
        phone: v.phone,
        // Clowe has already verified the account (Secure ID): not paid for twice.
        verify_account: false,
        dashboard_access: false,
        bank: { account_number: v.bank.accountNumber, account_holder: v.bank.accountHolder, ifsc: v.bank.ifsc },
        kyc_details: kyc,
      },
      `vendor:${v.vendorId}`,
    );
    if (reply.ok) return statusOf(reply.body);
    if (reply.status === 409) return this.vendorStatus(v.vendorId);
    throw this.error('create vendor', reply);
  }

  /** The vendor's status at Cashfree (ACTIVE, IN_BENE_CREATION, …), or null if there is none. */
  async vendorStatus(vendorId: string): Promise<string> {
    const reply = await this.call('GET', `${this.baseUrl}/vendors/${encodeURIComponent(vendorId)}`);
    if (reply.ok) return statusOf(reply.body);
    throw this.error('get vendor', reply);
  }

  /** The vendor shares on an order, with when each becomes eligible for settlement. */
  async orderShares(orderId: string): Promise<VendorShare[]> {
    const reply = await this.call('GET', `${this.baseUrl}/orders/${encodeURIComponent(orderId)}`);
    if (!reply.ok) throw this.error('get order split', reply);
    const vendors = (reply.body as { vendors?: unknown }).vendors;
    if (!Array.isArray(vendors)) return [];
    return vendors.map((x: Record<string, unknown>) => ({
      vendorId: String(x.vendor_id ?? ''),
      amountPaise: paiseFromRupees(x.settlement_amount),
      eligibleAt: typeof x.settlement_eligibility_date === 'string' ? x.settlement_eligibility_date : null,
    }));
  }

  /** Settle a deferred share at `at` (now) instead of at the end of the deferral. */
  async release(orderId: string, vendorId: string, at: Date): Promise<void> {
    const url = `${this.legacyUrl}/orders/${encodeURIComponent(orderId)}/settlement-eligibility/vendors/${encodeURIComponent(vendorId)}`;
    // The field is settlementEligibilityDate (yyyy-MM-dd HH:mm:ss, India time), as the sandbox requires —
    // not the …Update name some of Cashfree's pages show.
    const reply = await this.call('PUT', url, { settlementEligibilityDate: istStamp(at) }, undefined, true);
    if (!reply.ok) throw this.error('release vendor share', reply);
    const status = (reply.body as { status?: unknown }).status;
    if (typeof status === 'string' && status.toUpperCase() !== 'OK') {
      const message = (reply.body as { message?: unknown }).message;
      throw new GatewayError(`Cashfree release vendor share refused: ${typeof message === 'string' ? message.slice(0, 200) : status}`, 400, 'release_refused');
    }
  }

  // -------------------------------------------------------------------------

  private async call(
    method: string,
    url: string,
    payload?: unknown,
    idempotencySeed?: string,
    legacy = false,
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; code: string; message: string }> {
    const headers: Record<string, string> = legacy
      ? { 'X-Client-Id': this.config.clientId, 'X-Client-Secret': this.config.clientSecret }
      : {
          'x-api-version': CASHFREE_PG_API_VERSION,
          'x-client-id': this.config.clientId,
          'x-client-secret': this.config.clientSecret,
        };
    headers.accept = 'application/json';
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (idempotencySeed) headers['x-idempotency-key'] = idempotencyKey(idempotencySeed);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const kind = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new GatewayError(`Cashfree Easy Split ${method}: ${kind}`, 0, 'network');
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
      `Cashfree Easy Split ${what} failed (HTTP ${reply.status}${reply.code ? ` ${reply.code}` : ''})${reply.message ? `: ${reply.message}` : ''}`,
      reply.status,
      reply.code,
    );
  }
}

function statusOf(body: unknown): string {
  const s = body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined;
  return typeof s === 'string' ? s.toUpperCase() : 'UNKNOWN';
}
