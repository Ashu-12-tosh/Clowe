import { z } from 'zod';
import { assetRefSchema } from './assets';
import { codRefundAccountSchema } from './codRefund';

// ---------------------------------------------------------------------------
// Return, Exchange and Refund Policy — claims (clauses 1–7).
//
// Nothing is returnable on discretionary grounds (1): no change of mind, no
// size or colour preference, no try-on mismatch. A claim is for a delivered
// item that is defective, damaged in transit or tampered with, the wrong
// item / size / colour, incomplete, counterfeit, or materially different from
// its page (2.1). It is raised within 48 hours of delivery, or within 7 days
// of noticing a latent defect (3.1, 3.3), with photos of the item, its tag
// and barcode and the packaging and label, and an unboxing video for damage,
// missing or wrong items (3.2). The buyer chooses an identical exchange or a
// refund (2.2, 2.3); a second defect after an exchange is refunded (2.4).
//
// Items delivered before these rules took effect keep the old ones.
// ---------------------------------------------------------------------------

export const CLAIM_REASONS = ['DEFECTIVE', 'DAMAGED', 'WRONG_ITEM', 'MISSING_PARTS', 'COUNTERFEIT', 'NOT_AS_DESCRIBED'] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

export const CLAIM_REASON_LABELS: Record<ClaimReason, string> = {
  DEFECTIVE: 'Defective, or a manufacturing defect',
  DAMAGED: 'Damaged in transit, or packaging tampered with or broken',
  WRONG_ITEM: 'Wrong item, wrong size or wrong colour',
  MISSING_PARTS: 'Incomplete — a part, accessory or freebie is missing',
  COUNTERFEIT: 'Spurious or counterfeit',
  NOT_AS_DESCRIBED: 'Materially different from the product page',
};

/** Damage, missing or wrong items need the unboxing video (3.2). */
export const CLAIM_REASONS_NEED_VIDEO: readonly ClaimReason[] = ['DAMAGED', 'MISSING_PARTS', 'WRONG_ITEM'];

/** A non-returnable item can be claimed only as wrong, counterfeit or non-conforming (5.1). */
export const CLAIM_REASONS_NON_RETURNABLE: readonly ClaimReason[] = ['WRONG_ITEM', 'COUNTERFEIT', 'NOT_AS_DESCRIBED'];

export const CLAIM_REMEDIES = ['EXCHANGE', 'REFUND'] as const;
export type ClaimRemedy = (typeof CLAIM_REMEDIES)[number];

export const CLAIM_WINDOW_HOURS = 48;

/**
 * The returns rule as every product, cart, checkout, order and compare page
 * shows it: no change-of-mind returns, a claim window for damaged, wrong or
 * defective items — or "Not returnable" for an item whose category says so.
 */
export function returnRuleText(returnable: boolean, claimWindowHours: number = CLAIM_WINDOW_HOURS): string {
  return returnable ? `${claimWindowHours}-hour claim window for damaged, wrong or defective items` : 'Not returnable';
}
/** A latent defect: claimed within 7 days of noticing it (3.3). */
export const LATENT_DEFECT_DAYS = 7;
/**
 * The longest after delivery a latent defect is taken: the policy says
 * "within any manufacturer's warranty period", which the platform does not
 * hold per product, so a fixed outer limit stands in for it.
 */
export const LATENT_CLAIM_MAX_DAYS = 180;
/** Self-shipping when pickup is not serviceable: courier charges up to ₹100 (7.2). */
export const SELF_SHIP_MAX_PAISE = 10_000;
/** A refund starts within 3 working days of the item clearing quality check (6.2). */
export const REFUND_START_WORKING_DAYS = 3;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Where a delivered item stands for a claim at `now`. */
export function claimWindow(deliveredAt: Date, now: Date = new Date()): { open: boolean; endsAt: Date; latentUntil: Date } {
  const endsAt = new Date(deliveredAt.getTime() + CLAIM_WINDOW_HOURS * HOUR);
  return { open: now <= endsAt, endsAt, latentUntil: new Date(deliveredAt.getTime() + LATENT_CLAIM_MAX_DAYS * DAY) };
}

/**
 * Why this claim cannot be raised now, or null. Inside 48 hours any reason
 * goes; after it, only a defect the buyer says was latent, noticed after
 * delivery and no more than 7 days ago.
 */
export function claimTimingProblem(input: {
  reason: ClaimReason;
  deliveredAt: Date;
  latentNoticedAt?: Date | null;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const w = claimWindow(input.deliveredAt, now);
  if (w.open) return null;
  if (input.reason !== 'DEFECTIVE' || !input.latentNoticedAt) {
    return `Claims are raised within ${CLAIM_WINDOW_HOURS} hours of delivery. A hidden defect that showed later can still be claimed: choose "Defective" and say when you noticed it.`;
  }
  const noticed = input.latentNoticedAt;
  if (noticed.getTime() < input.deliveredAt.getTime() || noticed.getTime() > now.getTime() + HOUR) {
    return 'The date you noticed the defect must be after delivery, and not in the future';
  }
  if (now.getTime() - noticed.getTime() > LATENT_DEFECT_DAYS * DAY) {
    return `A hidden defect is claimed within ${LATENT_DEFECT_DAYS} days of noticing it`;
  }
  if (now > w.latentUntil) return `Defects are taken up to ${LATENT_CLAIM_MAX_DAYS} days after delivery`;
  return null;
}

export const claimRequestSchema = z
  .object({
    reason: z.enum(CLAIM_REASONS),
    details: z.string().trim().max(500).optional(),
    remedy: z.enum(CLAIM_REMEDIES),
    /** The item, showing the defect, damage or discrepancy. */
    photos: z.array(assetRefSchema).min(1, 'Add a photo of the item showing the problem').max(3, 'Up to 3 photos'),
    /** The brand tag and barcode. */
    tagPhotos: z.array(assetRefSchema).min(1, 'Add a photo of the brand tag and barcode').max(3, 'Up to 3 photos'),
    /** The outer packaging and shipping label. */
    packagingPhotos: z.array(assetRefSchema).min(1, 'Add a photo of the outer packaging and shipping label').max(3, 'Up to 3 photos'),
    unboxingVideo: assetRefSchema.optional(),
    /** A latent defect: when it became apparent (ISO date). */
    latentNoticedAt: z.coerce.date().optional(),
    /** Cash on Delivery orders only, and required there: where a refund is sent. */
    codRefundAccount: codRefundAccountSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (CLAIM_REASONS_NEED_VIDEO.includes(val.reason) && !val.unboxingVideo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unboxingVideo'],
        message: 'Add your unboxing video — it is needed for damaged, missing or wrong items',
      });
    }
    if (val.latentNoticedAt && val.reason !== 'DEFECTIVE') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['latentNoticedAt'], message: 'Only a defect can be claimed as hidden' });
    }
  });
export type ClaimRequestInput = z.infer<typeof claimRequestSchema>;

/** The buyer's self-ship receipt when pickup is not serviceable (7.2). */
export const selfShipReceiptSchema = z.object({
  receipt: assetRefSchema,
  costPaise: z.number().int().min(1).max(100_000),
});

/** An admin reimbursing self-ship courier charges, paid by hand. */
export const selfShipReimburseSchema = z.object({
  amountPaise: z.number().int().min(1).max(SELF_SHIP_MAX_PAISE, `Courier charges are reimbursed up to ₹${SELF_SHIP_MAX_PAISE / 100}`),
  reference: z.string().trim().min(4, 'Give the UPI or bank reference').max(60),
});

/** A claim's evidence as the seller and the desk see it (URLs are short-lived). */
export interface ClaimEvidenceView {
  remedy: ClaimRemedy | null;
  tagPhotos: string[];
  packagingPhotos: string[];
  unboxingVideoUrl: string | null;
  latentNoticedAt: string | null;
  qcNote: string | null;
  selfShip: { receiptUrl: string | null; costPaise: number | null; reimbursedPaise: number | null } | null;
  /** Admins only: why the buyer's account is under review, if it is. */
  buyerUnderReview?: string | null;
}

/**
 * Is a returned item back with the seller, so it can be checked? The courier
 * delivered the reverse pickup to them; or the buyer shipped it themselves
 * (pickup not serviceable, Return Policy 7.2) with the receipt uploaded, and
 * the seller confirms arrival by checking it; or, for a return from before
 * reverse pickups were booked, the courier has at least collected it.
 *
 * Before (pre-launch audit 2026-10-20, H3) "Item received back" was offered
 * for any approved return: a seller could pass or fail the check — refund,
 * or send back and put the buyer under review — while the item was still
 * with the buyer.
 */
export function returnItemBack(r: { pickupStatus: string | null; selfShip: boolean; selfShipReceipt: boolean; pickedUp: boolean }): boolean {
  if (r.pickupStatus) return r.pickupStatus === 'DELIVERED';
  if (r.selfShip) return r.selfShipReceipt;
  return r.pickedUp;
}

export const RETURN_NOT_BACK_MESSAGE = 'The item is not back with you yet — check it once the courier has delivered it to you.';
