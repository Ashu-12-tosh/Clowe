import { Router } from 'express';
import { z } from 'zod';
import {
  promotionCreditPurchaseSchema,
  promotionCreditVerifySchema,
  type PromotionCreditPurchaseResult,
  type PromotionCreditSettleResult,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { paymentProvider } from '../services/payments';
import { balance, settlePromotionPurchase } from '../services/sellerLedgerService';
import { blockSuspendedWrites, requireSeller } from './seller';

export const sellerPromotionCreditsRouter = Router();
sellerPromotionCreditsRouter.use(requireAuth, requireSeller, blockSuspendedWrites);

// ---------------------------------------------------------------------------
// Top-ups go through the same gateway orders use: a pending purchase row, a
// provider order, then a settle step. In dev the mock provider settles via
// /mock-pay; with Razorpay the checkout widget calls back into /verify.
// Both end in settlePromotionPurchase, which is the only thing that credits
// the ledger — and does so once per purchase, by the (purchaseId, type) pair.
// ---------------------------------------------------------------------------

sellerPromotionCreditsRouter.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: { balancePaise: await balance(req.seller!.id, 'PROMOTION') } });
  } catch (err) {
    next(err);
  }
});

sellerPromotionCreditsRouter.post('/purchase', async (req, res, next) => {
  try {
    const { amountPaise } = promotionCreditPurchaseSchema.parse(req.body);
    const purchase = await prisma.promotionCreditPurchase.create({
      data: { sellerId: req.seller!.id, amountPaise, provider: paymentProvider.name },
    });
    const providerOrderId = await paymentProvider.createOrder(amountPaise, `PROMO-${purchase.id}`);
    await prisma.promotionCreditPurchase.update({ where: { id: purchase.id }, data: { providerOrderId } });

    const body: PromotionCreditPurchaseResult = {
      purchaseId: purchase.id,
      amountPaise,
      payment: { provider: paymentProvider.name, providerOrderId, keyId: paymentProvider.publicKeyId },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

async function ownPurchase(sellerId: string, id: string) {
  const purchase = await prisma.promotionCreditPurchase.findFirst({ where: { id, sellerId } });
  if (!purchase) throw ApiError.notFound('Purchase not found');
  return purchase;
}

const mockPaySchema = z.object({ outcome: z.enum(['success', 'failure']) });

/** Dev gateway: settle a top-up without a real payment. */
sellerPromotionCreditsRouter.post('/purchase/:id/mock-pay', async (req, res, next) => {
  try {
    if (paymentProvider.name !== 'mock') {
      throw ApiError.badRequest('Mock payments are disabled', 'MOCK_DISABLED');
    }
    const { outcome } = mockPaySchema.parse(req.body);
    const purchase = await ownPurchase(req.seller!.id, req.params.id);
    const result = await settlePromotionPurchase(
      purchase.id,
      outcome === 'success' ? `mock_pay_${Date.now()}` : null,
    );
    const body: PromotionCreditSettleResult = {
      status: result,
      balancePaise: await balance(req.seller!.id, 'PROMOTION'),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/** Real gateway: the checkout widget's signed callback. */
sellerPromotionCreditsRouter.post('/purchase/:id/verify', async (req, res, next) => {
  try {
    const input = promotionCreditVerifySchema.parse(req.body);
    const purchase = await ownPurchase(req.seller!.id, req.params.id);
    if (purchase.providerOrderId !== input.razorpayOrderId) {
      throw ApiError.badRequest('Payment/order mismatch');
    }
    const valid = paymentProvider.verifySignature(
      input.razorpayOrderId,
      input.razorpayPaymentId,
      input.razorpaySignature,
    );
    if (!valid) throw ApiError.badRequest('Invalid payment signature', 'SIGNATURE_INVALID');

    const result = await settlePromotionPurchase(purchase.id, input.razorpayPaymentId);
    const body: PromotionCreditSettleResult = {
      status: result,
      balancePaise: await balance(req.seller!.id, 'PROMOTION'),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
