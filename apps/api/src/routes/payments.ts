import { Router } from 'express';
import { mockPaySchema, paymentVerifySchema } from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { paymentProvider, RazorpayProvider } from '../services/payments';
import { settlePaymentFailure, settlePaymentSuccess } from '../services/orderService';

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

// ---------------------------------------------------------------------------
// Mock gateway (dev): settle a payment with a chosen outcome
// ---------------------------------------------------------------------------

paymentsRouter.post('/mock-pay', requireAuth, async (req, res, next) => {
  try {
    if (paymentProvider.name !== 'mock') {
      throw ApiError.badRequest('Mock payments are disabled', 'MOCK_DISABLED');
    }
    const { orderId, outcome } = mockPaySchema.parse(req.body);
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
// Razorpay checkout callback verification
// ---------------------------------------------------------------------------

paymentsRouter.post('/verify', requireAuth, async (req, res, next) => {
  try {
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
      payload?: { payment?: { entity?: { id: string; order_id: string; error_description?: string } } };
    };
    const entity = event.payload?.payment?.entity;
    if (entity) {
      const payment = await prisma.payment.findFirst({
        where: { providerOrderId: entity.order_id },
      });
      if (payment) {
        if (event.event === 'payment.captured') {
          await settlePaymentSuccess(payment.orderId, entity.id);
        } else if (event.event === 'payment.failed') {
          await settlePaymentFailure(payment.orderId, entity.error_description ?? 'Payment failed');
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});
