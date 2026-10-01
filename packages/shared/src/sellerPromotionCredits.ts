import { z } from 'zod';

// ---------------------------------------------------------------------------
// Promotion credits
//
// Sellers prepay for placements. Credits live in the PROMOTION bucket of the
// seller ledger: they can be spent on ads and never withdrawn, so a top-up
// cannot leak into a payout by construction.
// ---------------------------------------------------------------------------

/** Smallest and largest single top-up, in paise. */
export const PROMOTION_CREDIT_MIN_PAISE = 10_000; // ₹100
export const PROMOTION_CREDIT_MAX_PAISE = 50_000_000; // ₹5,00,000

export const promotionCreditPurchaseSchema = z.object({
  amountPaise: z
    .number()
    .int()
    .min(PROMOTION_CREDIT_MIN_PAISE, 'Minimum top-up is ₹100')
    .max(PROMOTION_CREDIT_MAX_PAISE, 'Maximum top-up is ₹5,00,000'),
});
export type PromotionCreditPurchaseInput = z.infer<typeof promotionCreditPurchaseSchema>;

/** What POST /purchase returns: a pending payment for the gateway to settle. */
export interface PromotionCreditPurchaseResult {
  purchaseId: string;
  amountPaise: number;
  payment: {
    provider: 'mock' | 'razorpay';
    providerOrderId: string;
    keyId?: string;
  };
}

export interface PromotionCreditSettleResult {
  status: 'PAID' | 'FAILED';
  /** Promotion balance after this purchase. */
  balancePaise: number;
}

export const promotionCreditVerifySchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});
