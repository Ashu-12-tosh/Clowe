import { describe, expect, it } from 'vitest';
import { CASHFREE_PG_API_VERSION, CashfreePaymentProvider } from './CashfreePaymentProvider';
import { GatewayError } from './PaymentProvider';
import { idempotencyKey, verifyCashfreeWebhook } from '../cashfree/client';
import { createHmac } from 'node:crypto';

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** A fetch that records what was sent and answers from a script. */
function fakeFetch(replies: Array<{ status: number; body: unknown } | Error>) {
  const sent: Sent[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    sent.push({
      method: init.method ?? 'GET',
      url: String(input),
      headers,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const next = replies.shift();
    if (!next) throw new Error('no scripted reply');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, impl };
}

const provider = (impl: typeof fetch) =>
  new CashfreePaymentProvider({ clientId: 'cid', clientSecret: 'secret', environment: 'sandbox', fetchImpl: impl });

const customer = { id: 'cmuser123', phone: '9876543210', name: 'Asha Rao', email: 'asha@example.com' };

describe('CashfreePaymentProvider.createOrder', () => {
  it('creates the order on the sandbox host with the pinned version, rupees and an idempotency key', async () => {
    const { sent, impl } = fakeFetch([
      { status: 200, body: { order_id: 'CLW-ABC123', cf_order_id: 77, payment_session_id: 'session_x', order_expiry_time: '2026-10-19T12:30:00+05:30' } },
    ]);
    const order = await provider(impl).createOrder({
      amountPaise: 123456,
      receipt: 'CLW-ABC123',
      customer,
      returnUrl: 'https://cloweshop.com/checkout/return?kind=ORDER&id=o1',
      notifyUrl: 'https://cloweshop.com/api/payments/cashfree/webhook',
      expiresAt: new Date('2026-10-19T07:00:00Z'),
    });
    expect(order).toEqual({ providerOrderId: 'CLW-ABC123', paymentSessionId: 'session_x', expiresAt: new Date('2026-10-19T07:00:00Z') });
    const req = sent[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://sandbox.cashfree.com/pg/orders');
    expect(req.headers['x-api-version']).toBe(CASHFREE_PG_API_VERSION);
    expect(req.headers['x-client-id']).toBe('cid');
    expect(req.headers['x-idempotency-key']).toBe(idempotencyKey('order:CLW-ABC123:plain'));
    expect(req.body).toMatchObject({
      order_id: 'CLW-ABC123',
      order_amount: 1234.56,
      order_currency: 'INR',
      customer_details: { customer_id: 'cmuser123', customer_phone: '9876543210', customer_name: 'Asha Rao', customer_email: 'asha@example.com' },
      order_meta: { return_url: 'https://cloweshop.com/checkout/return?kind=ORDER&id=o1', notify_url: 'https://cloweshop.com/api/payments/cashfree/webhook' },
    });
    expect(req.body).not.toHaveProperty('order_splits');
  });

  it('sends vendor splits in rupees, under a different idempotency key', async () => {
    const { sent, impl } = fakeFetch([{ status: 200, body: { order_id: 'CLW-S1', payment_session_id: 's' } }]);
    await provider(impl).createOrder({ amountPaise: 100000, receipt: 'CLW-S1', customer, splits: [{ vendorId: 'CLW_v1', amountPaise: 90759 }] });
    expect(sent[0]!.body!.order_splits).toEqual([{ vendor_id: 'CLW_v1', amount: 907.59 }]);
    expect(sent[0]!.headers['x-idempotency-key']).toBe(idempotencyKey('order:CLW-S1:split'));
  });

  it('reads the order back when it already exists (a retry after a lost answer)', async () => {
    const { sent, impl } = fakeFetch([
      { status: 409, body: { code: 'order_already_exists', message: 'exists' } },
      { status: 200, body: { order_id: 'CLW-R1', payment_session_id: 'session_again', order_status: 'ACTIVE', order_amount: 10 } },
    ]);
    const order = await provider(impl).createOrder({ amountPaise: 1000, receipt: 'CLW-R1', customer });
    expect(order.paymentSessionId).toBe('session_again');
    expect(sent[1]!.method).toBe('GET');
    expect(sent[1]!.url).toBe('https://sandbox.cashfree.com/pg/orders/CLW-R1');
  });

  it('drops a name too short or with odd characters rather than fail, and refuses an id Cashfree would', async () => {
    const { sent, impl } = fakeFetch([{ status: 200, body: { order_id: 'CLW-N1', payment_session_id: 's' } }]);
    await provider(impl).createOrder({ amountPaise: 1000, receipt: 'CLW-N1', customer: { id: 'u1', phone: '+91 98765 43210', name: 'Al', email: 'nope' } });
    const details = sent[0]!.body!.customer_details as Record<string, string>;
    expect(details).toEqual({ customer_id: 'u1cus', customer_phone: '9876543210' });
    await expect(provider(impl).createOrder({ amountPaise: 1000, receipt: 'bad id!', customer })).rejects.toBeInstanceOf(GatewayError);
  });

  it('reports a timeout as an uncertain gateway error', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const { impl } = fakeFetch([timeout]);
    const err = await provider(impl).createOrder({ amountPaise: 1000, receipt: 'CLW-T1', customer }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).uncertain).toBe(true);
  });
});

describe('CashfreePaymentProvider.fetchOrder', () => {
  it('maps the order and its attempts, newest first, amounts in paise', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { order_id: 'CLW-F1', order_status: 'PAID', order_amount: 499.5, order_currency: 'INR' } },
      {
        status: 200,
        body: [
          { cf_payment_id: 1, payment_status: 'FAILED', payment_amount: 499.5, payment_currency: 'INR', payment_message: 'Declined', payment_time: '2026-10-19T10:00:00+05:30' },
          { cf_payment_id: 2, payment_status: 'SUCCESS', payment_amount: 499.5, payment_currency: 'INR', payment_time: '2026-10-19T10:05:00+05:30' },
        ],
      },
    ]);
    const state = await provider(impl).fetchOrder('CLW-F1');
    expect(state.status).toBe('PAID');
    expect(state.amountPaise).toBe(49950);
    expect(state.attempts.map((a) => [a.providerPaymentId, a.status, a.amountPaise])).toEqual([
      ['2', 'SUCCESS', 49950],
      ['1', 'FAILED', 49950],
    ]);
  });

  it('treats anything not PAID/EXPIRED/TERMINATED as still payable', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { order_status: 'TERMINATION_REQUESTED', order_amount: 1 } },
      { status: 200, body: [] },
    ]);
    expect((await provider(impl).fetchOrder('CLW-X')).status).toBe('ACTIVE');
  });
});

describe('CashfreePaymentProvider.refund', () => {
  it('refunds with our refund id and vendor splits; PENDING stays pending', async () => {
    const { sent, impl } = fakeFetch([{ status: 200, body: { cf_refund_id: 'cf_r1', refund_id: 'ref1', refund_status: 'PENDING' } }]);
    const r = await provider(impl).refund({
      providerOrderId: 'CLW-1',
      providerPaymentId: '2',
      refundId: 'ref1',
      amountPaise: 25000,
      note: 'Return "Shirt"',
      splits: [{ vendorId: 'CLW_v1', amountPaise: 22000 }],
    });
    expect(r).toMatchObject({ providerRefundId: 'cf_r1', status: 'PENDING', providerStatus: 'PENDING', arn: null });
    expect(sent[0]!.url).toBe('https://sandbox.cashfree.com/pg/orders/CLW-1/refunds');
    expect(sent[0]!.body).toMatchObject({ refund_amount: 250, refund_id: 'ref1', refund_splits: [{ vendor_id: 'CLW_v1', amount: 220 }] });
    expect(sent[0]!.headers['x-idempotency-key']).toBe(idempotencyKey('refund:ref1'));
  });

  it('maps SUCCESS with its ARN, and CANCELLED / REJECTED as failed', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { cf_refund_id: 9, refund_status: 'SUCCESS', refund_arn: 'ARN123' } },
      { status: 200, body: { cf_refund_id: 10, refund_status: 'CANCELLED', status_description: 'Cancelled by bank' } },
      { status: 200, body: { cf_refund_id: 11, refund_status: 'ONHOLD' } },
    ]);
    const p = provider(impl);
    const base = { providerOrderId: 'o', providerPaymentId: 'p', amountPaise: 100 };
    expect(await p.refund({ ...base, refundId: 'ref-a1' })).toMatchObject({ status: 'SUCCESS', arn: 'ARN123', providerRefundId: '9' });
    expect(await p.refund({ ...base, refundId: 'ref-a2' })).toMatchObject({ status: 'FAILED', providerStatus: 'CANCELLED', message: 'Cancelled by bank' });
    expect(await p.refund({ ...base, refundId: 'ref-a3' })).toMatchObject({ status: 'PENDING', providerStatus: 'ONHOLD' });
  });

  it('a refused refund (400) is an answer: FAILED with the reason, not an outage', async () => {
    const { impl } = fakeFetch([{ status: 400, body: { code: 'refund_amount_invalid', message: 'amount is more than refundable' } }]);
    const r = await provider(impl).refund({ providerOrderId: 'o', providerPaymentId: 'p', refundId: 'ref-b1', amountPaise: 100 });
    expect(r).toMatchObject({ status: 'FAILED', providerStatus: 'refund_amount_invalid', message: 'amount is more than refundable' });
  });

  it('a duplicate refund id reads the existing refund; an unknown one is null', async () => {
    const { impl } = fakeFetch([
      { status: 409, body: { code: 'refund_already_exists' } },
      { status: 200, body: { cf_refund_id: 5, refund_status: 'SUCCESS' } },
      { status: 404, body: { code: 'refund_not_found' } },
    ]);
    const p = provider(impl);
    expect((await p.refund({ providerOrderId: 'o', providerPaymentId: 'p', refundId: 'ref-c1', amountPaise: 100 })).status).toBe('SUCCESS');
    expect(await p.fetchRefund('o', 'nope')).toBeNull();
  });

  it('a 5xx is thrown as uncertain, never reported as a failure', async () => {
    const { impl } = fakeFetch([{ status: 503, body: { message: 'down' } }]);
    const err = await provider(impl).refund({ providerOrderId: 'o', providerPaymentId: 'p', refundId: 'ref-d1', amountPaise: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).uncertain).toBe(true);
  });
});

describe('CashfreePaymentProvider.terminateOrder', () => {
  it('true when stopped, false when Cashfree refuses (a payment in flight)', async () => {
    const { sent, impl } = fakeFetch([
      { status: 200, body: { order_status: 'TERMINATED' } },
      { status: 400, body: { code: 'order_payment_in_progress' } },
    ]);
    const p = provider(impl);
    expect(await p.terminateOrder('CLW-1')).toBe(true);
    expect(sent[0]).toMatchObject({ method: 'PATCH', url: 'https://sandbox.cashfree.com/pg/orders/CLW-1', body: { order_status: 'TERMINATED' } });
    expect(await p.terminateOrder('CLW-2')).toBe(false);
  });
});

describe('Cashfree webhook signature', () => {
  const secret = 'whsec_test';
  const raw = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":"CLW-1"}}}');
  const ts = '1760870000';
  const sign = (t: string, body: Buffer) => createHmac('sha256', secret).update(t).update(body).digest('base64');

  it('accepts base64 HMAC-SHA256 of timestamp + raw body', () => {
    expect(verifyCashfreeWebhook(raw, ts, sign(ts, raw), secret)).toBe(true);
  });

  it('rejects a changed body, a changed timestamp, another secret, or nothing at all', () => {
    expect(verifyCashfreeWebhook(Buffer.from(`${raw.toString()} `), ts, sign(ts, raw), secret)).toBe(false);
    expect(verifyCashfreeWebhook(raw, '1760870001', sign(ts, raw), secret)).toBe(false);
    expect(verifyCashfreeWebhook(raw, ts, sign(ts, raw), 'other')).toBe(false);
    expect(verifyCashfreeWebhook(raw, '', '', secret)).toBe(false);
  });
});

describe('idempotencyKey', () => {
  it('is a stable version-4-shaped UUID per seed', () => {
    const a = idempotencyKey('refund:abc');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotencyKey('refund:abc')).toBe(a);
    expect(idempotencyKey('refund:abd')).not.toBe(a);
  });
});
