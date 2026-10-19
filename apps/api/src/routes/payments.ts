import { createHash } from 'node:crypto';
import { Router } from 'express';
import { mockPaySchema, paymentConfirmSchema, paymentVerifySchema, STORE_CLOSED_MESSAGE, type PaymentConfirmResult } from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { paymentConfirmLimiter } from '../middleware/rateLimits';
import { ApiError } from '../utils/ApiError';
import { paymentProvider, RazorpayProvider } from '../services/payments';
import { verifyCashfreeWebhook } from '../services/cashfree/client';
import {
  checkoutPayload,
  recordWebhook,
  refundLatePayment,
  syncGatewayPayment,
  targetByProviderOrderId,
  targetOf,
  webhookSeen,
  type GatewayTarget,
} from '../services/payments/gatewaySync';
import { refundByGatewayId, syncGatewayRefund } from '../services/refundService';
import { markVendorSettled } from '../services/easySplit';
import { settlePaymentFailure, settlePaymentSuccess } from '../services/orderService';
import { assertMockPaymentAllowed, canPlaceOrders } from '../services/storeOpen';

export const paymentsRouter = Router();

/** Loads the caller's order or 404s. */
async function ownOrder(userId: string, orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true },
  });
  if (!order || order.userId !== userId) throw ApiError.notFound('Order not found');
  return order;
}

/** The caller's payable (order or top-up) behind a gateway payment, or 404. */
async function ownTarget(userId: string, kind: GatewayTarget['kind'], id: string): Promise<GatewayTarget> {
  const target = await targetOf(kind, id);
  if (!target || target.userId !== userId) throw ApiError.notFound('Payment not found');
  return target;
}

// ---------------------------------------------------------------------------
// Mock gateway (dev): settle a payment with a chosen outcome
// ---------------------------------------------------------------------------

paymentsRouter.post('/mock-pay', requireAuth, async (req, res, next) => {
  try {
    if (paymentProvider.name !== 'mock') {
      throw ApiError.badRequest('Mock payments are disabled', 'MOCK_DISABLED');
    }
    const { orderId, outcome } = mockPaySchema.parse(req.body);
    if (outcome === 'success') await assertMockPaymentAllowed(req.auth!.userId);
    const order = await ownOrder(req.auth!.userId, orderId);
    if (!order.payment || order.payment.status !== 'CREATED') {
      throw ApiError.badRequest('This order is not awaiting payment');
    }

    if (outcome === 'success') {
      await settlePaymentSuccess(order.id, `mock_pay_${Date.now()}`);
    } else {
      await settlePaymentFailure(order.id, 'Mock payment declined');
    }
    res.json({ success: true, data: { orderId: order.id, outcome } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// After checkout: did it go through? (Cashfree — the server asks the gateway)
// ---------------------------------------------------------------------------

paymentsRouter.post('/confirm', requireAuth, paymentConfirmLimiter, async (req, res, next) => {
  try {
    const { kind, id } = paymentConfirmSchema.parse(req.body);
    const target = await ownTarget(req.auth!.userId, kind, id);
    const result = await syncGatewayPayment(target);
    // After a failed attempt the same gateway order can be paid again, with
    // the same session, until it expires — but not while the store is closed
    // to this shopper: an order placed before it closed is not paid now.
    const retryable = result.outcome === 'RETRY' || (result.outcome === 'PENDING' && target.status === 'CREATED');
    const reopen = retryable && (await canPlaceOrders(req.auth!.userId));
    const body: PaymentConfirmResult = {
      outcome: result.outcome,
      message: retryable && !reopen ? STORE_CLOSED_MESSAGE : (result.message ?? null),
      checkout: reopen ? checkoutPayload(target) : null,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Razorpay checkout callback verification
// ---------------------------------------------------------------------------

paymentsRouter.post('/verify', requireAuth, async (req, res, next) => {
  try {
    // Only Razorpay signs its callback; with any other gateway this route has
    // nothing to check, so it settles nothing.
    if (paymentProvider.name !== 'razorpay') {
      throw ApiError.badRequest('This payment is confirmed another way', 'SIGNATURE_FLOW_UNAVAILABLE');
    }
    const input = paymentVerifySchema.parse(req.body);
    const order = await ownOrder(req.auth!.userId, input.orderId);
    if (!order.payment || order.payment.providerOrderId !== input.razorpayOrderId) {
      throw ApiError.badRequest('Payment/order mismatch');
    }
    const valid = paymentProvider.verifySignature(
      input.razorpayOrderId,
      input.razorpayPaymentId,
      input.razorpaySignature,
    );
    if (!valid) throw ApiError.badRequest('Invalid payment signature', 'SIGNATURE_INVALID');

    await settlePaymentSuccess(order.id, input.razorpayPaymentId);
    res.json({ success: true, data: { orderId: order.id, status: 'PAID' } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Cashfree webhook: payments, refunds, Easy Split vendor settlements
// ---------------------------------------------------------------------------

/** Pull a string out of a webhook body by trying a few paths. */
function pick(body: unknown, ...paths: string[][]): string | null {
  for (const path of paths) {
    let cur: unknown = body;
    for (const key of path) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
    if (typeof cur === 'string' && cur.trim()) return cur.trim();
    if (typeof cur === 'number') return String(cur);
  }
  return null;
}

/**
 * Signed with the gateway's client secret over timestamp + raw body. What the
 * body says is only a prompt: each event is handled by asking Cashfree's API
 * for the current state, so a replayed or reordered delivery can do no harm.
 * Redeliveries are recognised by their x-idempotency-key and acknowledged
 * without being handled twice. Anything not understood is acknowledged too —
 * a non-200 only makes Cashfree retry, and then switch the webhook off.
 */
paymentsRouter.post('/cashfree/webhook', async (req, res, next) => {
  try {
    const secret = env.CASHFREE_PG_CLIENT_SECRET;
    if (!secret || paymentProvider.name !== 'cashfree') return res.status(200).json({ received: true });

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.get('x-webhook-signature') ?? '';
    const timestamp = req.get('x-webhook-timestamp') ?? '';
    if (!rawBody || !verifyCashfreeWebhook(rawBody, timestamp, signature, secret)) {
      throw ApiError.unauthorized('Invalid webhook signature');
    }

    const body = req.body as { type?: unknown };
    const type = typeof body.type === 'string' ? body.type : 'UNKNOWN';
    const eventKey = req.get('x-idempotency-key') || createHash('sha256').update(rawBody).digest('hex');
    if (await webhookSeen('cashfree-pg', eventKey)) return res.status(200).json({ received: true, duplicate: true });

    let reference: string | null = null;
    if (type.startsWith('PAYMENT_')) {
      reference = pick(body, ['data', 'order', 'order_id']);
      const target = reference ? await targetByProviderOrderId(reference) : null;
      if (target) await syncGatewayPayment(target);
    } else if (type.includes('REFUND')) {
      reference = pick(body, ['data', 'refund', 'refund_id']);
      const refundId = reference ? await refundByGatewayId(reference) : null;
      if (refundId) await syncGatewayRefund(refundId);
    } else if (type.startsWith('VENDOR_SETTLEMENT')) {
      reference = pick(body, ['data', 'vendor_id'], ['data', 'settlement', 'vendor_id']);
      const status = pick(body, ['data', 'status'], ['data', 'settlement', 'status']);
      if (reference && type === 'VENDOR_SETTLEMENT_SUCCESS' && (!status || status.toUpperCase() === 'SUCCESS')) {
        await markVendorSettled(reference, pick(body, ['data', 'utr'], ['data', 'settlement', 'utr']));
      }
    }
    await recordWebhook('cashfree-pg', eventKey, type, reference);
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Razorpay webhook (server-to-server source of truth)
// ---------------------------------------------------------------------------

paymentsRouter.post('/webhook', async (req, res, next) => {
  try {
    const secret = env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(200).json({ received: true }); // webhook not configured

    const signature = req.headers['x-razorpay-signature'];
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (typeof signature !== 'string' || !rawBody) {
      throw ApiError.badRequest('Missing webhook signature');
    }
    if (!RazorpayProvider.verifyWebhook(rawBody, signature, secret)) {
      throw ApiError.unauthorized('Invalid webhook signature');
    }

    const event = req.body as {
      event: string;
      payload?: { payment?: { entity?: { id: string; order_id: string; amount?: number; currency?: string } } };
    };
    const entity = event.payload?.payment?.entity;
    // payment.failed is one attempt; the buyer can try again on the same
    // order, and the sweeper cancels it if nobody pays in time.
    if (entity && event.event === 'payment.captured') {
      const payment = await prisma.payment.findFirst({ where: { providerOrderId: entity.order_id } });
      if (payment && entity.currency === 'INR' && entity.amount === payment.amountPaise) {
        const result = await settlePaymentSuccess(payment.orderId, entity.id);
        if (result === 'LATE') {
          const target = await targetOf('ORDER', payment.orderId);
          if (target) await refundLatePayment(target, entity.id);
        }
      } else if (payment) {
        console.error(`[clowe-api] Razorpay capture on ${entity.order_id} does not match the order amount — not settled`);
      }
    }
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});
