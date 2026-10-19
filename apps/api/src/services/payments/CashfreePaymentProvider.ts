import {
  cashfreeErrorCode,
  cashfreeHost,
  idempotencyKey,
  ipv4Fetch,
  paiseFromRupees,
  rupeesFromPaise,
  type CashfreeEnvironment,
} from '../cashfree/client';
import {
  GatewayError,
  type CreateGatewayOrderInput,
  type GatewayOrder,
  type GatewayOrderState,
  type GatewayPaymentAttempt,
  type GatewayRefund,
  type GatewayRefundInput,
  type PaymentProvider,
} from './PaymentProvider';

/** The API version every call is pinned to (the current one at the time of writing). */
export const CASHFREE_PG_API_VERSION = '2026-01-01';

export interface CashfreePgConfig {
  clientId: string;
  clientSecret: string;
  environment: CashfreeEnvironment;
  /** Another host for the chosen environment — tests only. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Cashfree's order_id: 3–45 of letters, digits, underscore and hyphen. */
const ORDER_ID = /^[A-Za-z0-9_-]{3,45}$/;
/** Cashfree's refund_id: 3–40 letters and digits (underscore and hyphen are accepted too). */
const REFUND_ID = /^[A-Za-z0-9_-]{3,40}$/;

interface OrderBody {
  order_id?: unknown;
  cf_order_id?: unknown;
  payment_session_id?: unknown;
  order_status?: unknown;
  order_amount?: unknown;
  order_currency?: unknown;
  order_expiry_time?: unknown;
}
interface PaymentBody {
  cf_payment_id?: unknown;
  payment_status?: unknown;
  payment_amount?: unknown;
  payment_currency?: unknown;
  payment_message?: unknown;
  payment_time?: unknown;
  payment_completion_time?: unknown;
}
interface RefundBody {
  cf_refund_id?: unknown;
  refund_id?: unknown;
  refund_status?: unknown;
  refund_arn?: unknown;
  status_description?: unknown;
}

type Reply<T> = { ok: true; status: number; body: T } | { ok: false; status: number; code: string; message: string };

const ATTEMPT_STATUSES = new Set(['SUCCESS', 'PENDING', 'FAILED', 'USER_DROPPED', 'CANCELLED', 'VOID', 'NOT_ATTEMPTED']);

/**
 * Cashfree Payment Gateway (PG API, x-api-version 2026-01-01).
 *
 *   POST  /pg/orders                              create; returns payment_session_id
 *   GET   /pg/orders/{order_id}                   order_status: ACTIVE | PAID | EXPIRED | TERMINATED
 *   GET   /pg/orders/{order_id}/payments          every attempt on it
 *   PATCH /pg/orders/{order_id}                   { order_status: TERMINATED }
 *   POST  /pg/orders/{order_id}/refunds           refund_id is ours
 *   GET   /pg/orders/{order_id}/refunds/{id}
 *
 * Every write carries an x-idempotency-key derived from our own id for it, so
 * a request that timed out and is sent again is the same request to Cashfree.
 * Nothing here retries on its own; callers own that decision.
 */
export class CashfreePaymentProvider implements PaymentProvider {
  readonly name = 'cashfree';
  readonly mode: CashfreeEnvironment;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CashfreePgConfig) {
    this.mode = config.environment;
    this.baseUrl = `${config.baseUrl ?? cashfreeHost(config.environment)}/pg`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? ipv4Fetch;
  }

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    if (!ORDER_ID.test(input.receipt)) throw new GatewayError(`Order id "${input.receipt}" is not one Cashfree accepts`, 400, 'order_id_invalid');
    const customer: Record<string, string> = {
      customer_id: customerId(input.customer.id),
      customer_phone: input.customer.phone.replace(/\D/g, '').slice(-10),
    };
    const name = input.customer.name?.replace(/[^A-Za-z0-9 .'-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name && name.length >= 3) customer.customer_name = name.slice(0, 100);
    const email = input.customer.email?.trim();
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 100) customer.customer_email = email;

    const meta: Record<string, string> = {};
    if (input.returnUrl) meta.return_url = input.returnUrl;
    if (input.notifyUrl) meta.notify_url = input.notifyUrl;

    const payload: Record<string, unknown> = {
      order_id: input.receipt,
      order_amount: rupeesFromPaise(input.amountPaise),
      order_currency: 'INR',
      customer_details: customer,
      order_meta: meta,
    };
    if (input.expiresAt) payload.order_expiry_time = input.expiresAt.toISOString();
    if (input.note) payload.order_note = input.note.slice(0, 200);
    if (input.splits?.length) {
      payload.order_splits = input.splits.map((s) => ({ vendor_id: s.vendorId, amount: rupeesFromPaise(s.amountPaise) }));
    }

    // The key differs with and without splits: retrying without them after
    // Easy Split refused is a different request, not a replay.
    const reply = await this.call<OrderBody>('POST', '/orders', payload, `order:${input.receipt}:${input.splits?.length ? 'split' : 'plain'}`);
    // Sent before, and the first answer was lost: the order is there to read.
    const body = reply.ok ? reply.body : reply.status === 409 ? await this.readOrder(input.receipt) : this.fail('create order', reply);
    const sessionId = typeof body.payment_session_id === 'string' ? body.payment_session_id : '';
    if (!sessionId) throw new GatewayError('Cashfree created the order without a payment session', 502, 'no_session');
    const expiry = typeof body.order_expiry_time === 'string' ? new Date(body.order_expiry_time) : undefined;
    return {
      providerOrderId: typeof body.order_id === 'string' ? body.order_id : input.receipt,
      paymentSessionId: sessionId,
      expiresAt: expiry && !Number.isNaN(expiry.getTime()) ? expiry : input.expiresAt,
    };
  }

  /** No browser signature with Cashfree: the server asks fetchOrder instead. */
  verifySignature(): boolean {
    return false;
  }

  async fetchOrder(providerOrderId: string): Promise<GatewayOrderState> {
    const order = await this.readOrder(providerOrderId);
    const raw = typeof order.order_status === 'string' ? order.order_status.toUpperCase() : '';
    const status: GatewayOrderState['status'] =
      raw === 'PAID' ? 'PAID' : raw === 'EXPIRED' ? 'EXPIRED' : raw === 'TERMINATED' ? 'TERMINATED' : 'ACTIVE';
    // TERMINATION_REQUESTED is still ACTIVE until it is TERMINATED.
    const amountPaise = paiseFromRupees(order.order_amount);
    if (!Number.isFinite(amountPaise)) throw new GatewayError('Cashfree order without an amount', 502, 'malformed');

    const reply = await this.call<PaymentBody[]>('GET', `/orders/${encodeURIComponent(providerOrderId)}/payments`);
    if (!reply.ok) this.fail('list payments', reply);
    const list = Array.isArray(reply.body) ? reply.body : [];
    const attempts = list.map(attemptFrom).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    return {
      status,
      amountPaise,
      currency: typeof order.order_currency === 'string' ? order.order_currency : 'INR',
      attempts,
    };
  }

  async terminateOrder(providerOrderId: string): Promise<boolean> {
    const reply = await this.call<OrderBody>(
      'PATCH',
      `/orders/${encodeURIComponent(providerOrderId)}`,
      { order_status: 'TERMINATED' },
      `terminate:${providerOrderId}`,
    );
    if (reply.ok) return true;
    if (reply.status >= 400 && reply.status < 500 && reply.status !== 401 && reply.status !== 403 && reply.status !== 429) return false;
    return this.fail('terminate order', reply);
  }

  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    if (!REFUND_ID.test(input.refundId)) throw new GatewayError('Refund id is not one Cashfree accepts', 400, 'refund_id_invalid');
    const payload: Record<string, unknown> = {
      refund_amount: rupeesFromPaise(input.amountPaise),
      refund_id: input.refundId,
    };
    const note = input.note?.replace(/[^A-Za-z0-9 .,:/()-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (note && note.length >= 3) payload.refund_note = note.slice(0, 100);
    if (input.splits?.length) {
      payload.refund_splits = input.splits.map((s) => ({ vendor_id: s.vendorId, amount: rupeesFromPaise(s.amountPaise) }));
    }
    const path = `/orders/${encodeURIComponent(input.providerOrderId)}/refunds`;
    const reply = await this.call<RefundBody>('POST', path, payload, `refund:${input.refundId}`);
    if (reply.ok) return refundFrom(reply.body, input.refundId);
    // Already made under this id (a retry): read it back rather than fail.
    if (reply.status === 409) {
      const existing = await this.fetchRefund(input.providerOrderId, input.refundId);
      if (existing) return existing;
    }
    // A refund Cashfree refuses outright (over the amount, past six months…)
    // is an answer, not an outage.
    if (reply.status === 400 || reply.status === 422) {
      return {
        providerRefundId: '',
        status: 'FAILED',
        providerStatus: reply.code || 'REJECTED',
        message: reply.message || reply.code || 'Refund refused by the gateway',
      };
    }
    return this.fail('create refund', reply);
  }

  async fetchRefund(providerOrderId: string, refundId: string): Promise<GatewayRefund | null> {
    const reply = await this.call<RefundBody>(
      'GET',
      `/orders/${encodeURIComponent(providerOrderId)}/refunds/${encodeURIComponent(refundId)}`,
    );
    if (reply.ok) return refundFrom(reply.body, refundId);
    if (reply.status === 404) return null;
    return this.fail('get refund', reply);
  }

  // -------------------------------------------------------------------------

  private async readOrder(providerOrderId: string): Promise<OrderBody> {
    const reply = await this.call<OrderBody>('GET', `/orders/${encodeURIComponent(providerOrderId)}`);
    return reply.ok ? reply.body : this.fail('get order', reply);
  }

  private async call<T>(method: string, path: string, payload?: unknown, idempotencySeed?: string): Promise<Reply<T>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-version': CASHFREE_PG_API_VERSION,
      'x-client-id': this.config.clientId,
      'x-client-secret': this.config.clientSecret,
    };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (idempotencySeed) headers['x-idempotency-key'] = idempotencyKey(idempotencySeed);

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
      throw new GatewayError(`Cashfree ${method} ${pathLabel(path)}: ${kind}`, 0, 'network');
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok) return { ok: true, status: res.status, body: body as T };
    const message =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message.slice(0, 200)
        : '';
    return { ok: false, status: res.status, code: cashfreeErrorCode(body), message };
  }

  private fail(what: string, reply: { status: number; code: string; message: string }): never {
    throw new GatewayError(
      `Cashfree ${what} failed (HTTP ${reply.status}${reply.code ? ` ${reply.code}` : ''})${reply.message ? `: ${reply.message}` : ''}`,
      reply.status,
      reply.code,
    );
  }
}

/** Our ids in a log line, without anything else from the path. */
function pathLabel(path: string): string {
  return path.split('?')[0];
}

/** Cashfree's customer_id: 3–50 letters and digits. A cuid already is one. */
function customerId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9]/g, '');
  return (clean.length >= 3 ? clean : `${clean}cus`).slice(0, 50);
}

function attemptFrom(p: PaymentBody): GatewayPaymentAttempt {
  const raw = typeof p.payment_status === 'string' ? p.payment_status.toUpperCase() : '';
  const at = typeof p.payment_completion_time === 'string' ? p.payment_completion_time : typeof p.payment_time === 'string' ? p.payment_time : '';
  const when = at ? new Date(at) : undefined;
  return {
    providerPaymentId: p.cf_payment_id === undefined || p.cf_payment_id === null ? '' : String(p.cf_payment_id),
    status: (ATTEMPT_STATUSES.has(raw) ? raw : 'OTHER') as GatewayPaymentAttempt['status'],
    amountPaise: paiseFromRupees(p.payment_amount),
    currency: typeof p.payment_currency === 'string' ? p.payment_currency : '',
    message: typeof p.payment_message === 'string' ? p.payment_message.slice(0, 200) : undefined,
    at: when && !Number.isNaN(when.getTime()) ? when : undefined,
  };
}

function refundFrom(body: RefundBody, refundId: string): GatewayRefund {
  const raw = typeof body.refund_status === 'string' ? body.refund_status.toUpperCase() : '';
  const status: GatewayRefund['status'] =
    raw === 'SUCCESS' ? 'SUCCESS' : raw === 'CANCELLED' || raw === 'REJECTED' || raw === 'FAILED' ? 'FAILED' : 'PENDING';
  return {
    providerRefundId: body.cf_refund_id === undefined || body.cf_refund_id === null ? refundId : String(body.cf_refund_id),
    status,
    providerStatus: raw || 'PENDING',
    arn: typeof body.refund_arn === 'string' && body.refund_arn.trim() ? body.refund_arn.trim() : null,
    message: typeof body.status_description === 'string' ? body.status_description.slice(0, 200) : null,
  };
}
