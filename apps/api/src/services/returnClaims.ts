import type { Prisma } from '@prisma/client';
import {
  CLAIM_REASON_LABELS,
  CLAIM_REASONS_NON_RETURNABLE,
  claimRequestSchema,
  claimTimingProblem,
  REFUND_START_WORKING_DAYS,
  type ClaimEvidenceView,
  type ClaimReason,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { assertOwnAssets, resolveFileUrls } from './assets';
import { encryptCodRefundAccount } from './codRefundCrypto';
import { orderLineReturnable } from './returnability';
import { nextRmaNumber } from './returnService';
import { sendToUserSafe } from './messaging';
import { paymentProvider } from './payments';
import { settleEarnedCredits } from './purchaseCredits';
import { MANUAL_COD_PROVIDER, processRefund } from './refundService';
import { createReplacementOrder } from './replacementOrder';
import { postEntry, postReturnReversal } from './sellerLedgerService';
import { valueOfLines } from './shipping/codAmount';

// ---------------------------------------------------------------------------
// Return Policy claims, after the item is back with the seller.
//
// Quality check passed (4.3): an exchange sends an identical item free — the
// seller ships it and pays the freight — or, when none is in stock, the claim
// is refunded instead (2.3); a refund starts at once, well inside the 3
// working days of 6.2, for the net amount actually paid (6.5).
//
// Quality check failed — used, altered, substituted, not what was sent (4.3):
// the item goes back to the buyer at no cost, the buyer is told why, and the
// account is placed under review (8.1).
//
// Which rules a return is under is decided when it is raised: CLAIM for items
// delivered after the claim rules took effect (the "claimRulesFrom" setting,
// written by the migration that introduced them, i.e. at the deploy), LEGACY
// for everything delivered before.
// ---------------------------------------------------------------------------

/** When the claim rules took effect; null before they did. */
export async function claimRulesFrom(): Promise<Date | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'claimRulesFrom' } });
  const value = typeof row?.value === 'string' ? new Date(row.value) : null;
  return value && !Number.isNaN(value.getTime()) ? value : null;
}

export type ReturnRules = 'LEGACY' | 'CLAIM';

/** The rules a line delivered at `deliveredAt` is claimed under. */
export async function rulesForDelivery(deliveredAt: Date | null): Promise<ReturnRules> {
  const from = await claimRulesFrom();
  if (!from || !deliveredAt) return 'LEGACY';
  return deliveredAt.getTime() >= from.getTime() ? 'CLAIM' : 'LEGACY';
}

/**
 * Whether an exchange may be asked for: not when this item was itself an
 * exchange for a defect and is defective again — then it is refunded (2.4).
 */
export async function exchangeAllowed(itemId: string, reason: ClaimReason): Promise<boolean> {
  if (reason !== 'DEFECTIVE') return true;
  const item = await prisma.orderItem.findUnique({
    where: { id: itemId },
    select: { replacementOf: { select: { return: { select: { remedy: true, reasonCategory: true } } } } },
  });
  const before = item?.replacementOf?.return;
  return !(before?.remedy === 'EXCHANGE' && before.reasonCategory === 'DEFECTIVE');
}

/**
 * The line the buyer paid for, and the line the seller earned on, for a line
 * that may be a replacement: an exchange's replacement was paid on, and
 * earned on, the original; a lost parcel's replacement was paid on the
 * original but is itself the sale.
 */
async function moneyLinesOf(itemId: string): Promise<{ paidLineId: string; earnedLineId: string }> {
  let paidLineId = itemId;
  let earnedLineId: string | null = null;
  for (let hops = 0; hops < 10; hops += 1) {
    const line = await prisma.orderItem.findUniqueOrThrow({
      where: { id: paidLineId },
      select: { id: true, order: { select: { paymentMethod: true } }, replacementOf: { select: { id: true, deliveredAt: true } } },
    });
    if (!earnedLineId && !(line.replacementOf?.deliveredAt)) earnedLineId = line.id;
    if (!line.replacementOf || line.order.paymentMethod !== 'REPLACEMENT') break;
    paidLineId = line.replacementOf.id;
  }
  return { paidLineId, earnedLineId: earnedLineId ?? paidLineId };
}

const returnWithLine = (id: string) =>
  prisma.return.findUniqueOrThrow({
    where: { id },
    include: { orderItem: { include: { order: { include: { user: { select: { id: true, phone: true } } } } } } },
  });

/** Refund a claim: the net amount actually paid for the line, to how it was paid. */
async function refundClaim(r: Awaited<ReturnType<typeof returnWithLine>>, why: string): Promise<{ amountPaise: number }> {
  const item = r.orderItem;
  const { paidLineId, earnedLineId } = await moneyLinesOf(item.id);
  const paidLine = await prisma.orderItem.findUniqueOrThrow({ where: { id: paidLineId }, include: { order: { include: { items: true } } } });
  const amountPaise = valueOfLines(paidLine.order.totalPaise, paidLine.order.items, [paidLine.id]);
  const cod = paidLine.order.paymentMethod === 'COD';
  await prisma.$transaction([
    prisma.return.update({ where: { id: r.id }, data: { status: 'RECEIVED', qcPassed: true, resolution: 'REFUND' } }),
    prisma.orderItem.update({ where: { id: item.id }, data: { status: 'RETURNED' } }),
  ]);
  const refund = await prisma.refund.create({
    data: {
      returnId: r.id,
      orderId: paidLine.orderId,
      amountPaise,
      provider: cod ? MANUAL_COD_PROVIDER : paymentProvider.name,
      status: 'PENDING',
      reason: why,
    },
  });
  await postReturnReversal(earnedLineId);
  await settleEarnedCredits(paidLine.orderId);
  await prisma.notification.create({
    data: {
      userId: r.userId,
      type: 'REFUND_INITIATED',
      title: 'Refund initiated 💰',
      body: cod
        ? `${why}. We will transfer ₹${(amountPaise / 100).toLocaleString('en-IN')} to the bank account you gave within ${REFUND_START_WORKING_DAYS} working days, and tell you when it is sent.`
        : `${why}. Your refund of ₹${(amountPaise / 100).toLocaleString('en-IN')} has been started — it usually reaches you within 7 working days.`,
      linkHref: '/account/returns',
    },
  });
  await processRefund(refund.id);
  return { amountPaise };
}

export interface ClaimQcOutcome {
  outcome: 'EXCHANGED' | 'REFUNDED' | 'SENT_BACK';
  replacementOrderNumber?: string;
  refundPaise?: number;
  /** An exchange was asked for but no identical item was in stock. */
  outOfStock?: boolean;
}

/** The seller's (or an admin's) quality check of a CLAIM return that has come back. */
export async function settleClaimAfterQc(input: {
  returnId: string;
  passed: boolean;
  note?: string | null;
  /** The admin who checked it; null for the seller (stock moves are not attributed). */
  actorId: string | null;
}): Promise<ClaimQcOutcome> {
  const r = await returnWithLine(input.returnId);
  if (r.rules !== 'CLAIM') throw ApiError.badRequest('This return is under the earlier rules', 'NOT_A_CLAIM');
  if (r.status !== 'APPROVED') throw ApiError.badRequest(`Cannot check a return in status ${r.status}`);
  const item = r.orderItem;
  const label = `"${item.title}" (${item.order.orderNumber})`;
  const now = new Date();
  if (!input.passed && (input.note?.trim().length ?? 0) < 5) {
    throw ApiError.invalidField('note', 'Say what the check found — the buyer is told why');
  }
  // Only one check: whoever gets here first moves it on.
  const claimed = await prisma.return.updateMany({
    where: { id: r.id, status: 'APPROVED' },
    data: { status: 'RECEIVED', receivedAt: now, receivedCondition: input.passed ? 'OK' : 'DAMAGED', qcPassed: input.passed, qcNote: input.note ?? null },
  });
  if (claimed.count === 0) throw ApiError.badRequest('This return was just checked');

  if (!input.passed) {
    const reasons = input.note!.trim();
    const back = await createReplacementOrder({
      orderId: item.orderId,
      itemIds: [item.id],
      reason: `Your return ${r.rmaNumber} did not pass quality check`,
      actorId: input.actorId,
      fromStock: false,
    });
    await prisma.$transaction([
      prisma.return.update({
        where: { id: r.id },
        data: { status: 'RECEIVED', resolvedAt: now, sentBackOrderId: back?.orderId ?? null },
      }),
      // The sale stands: the item is the buyer's and goes back to them.
      prisma.orderItem.update({ where: { id: item.id }, data: { status: 'DELIVERED' } }),
      prisma.user.update({
        where: { id: r.userId },
        data: { claimsReviewAt: now, claimsReviewNote: `${r.rmaNumber}: failed quality check — ${reasons}` },
      }),
      prisma.notification.create({
        data: {
          userId: r.userId,
          type: 'RETURN_REJECTED',
          title: 'Return did not pass quality check',
          body: `${label} was checked and found: ${reasons}. Under the Return Policy (4.3) it is being sent back to you at no cost. If you disagree, raise it with Support.`,
          linkHref: '/account/returns',
        },
      }),
    ]);
    sendToUserSafe(
      r.userId,
      { channel: 'sms', to: `+91${item.order.user.phone}`, body: `Clowe: your return ${r.rmaNumber} did not pass quality check (${reasons}). The item is being sent back to you.` },
      { critical: true },
    );
    return { outcome: 'SENT_BACK' };
  }

  if (r.remedy === 'EXCHANGE') {
    const rep = await createReplacementOrder({
      orderId: item.orderId,
      itemIds: [item.id],
      reason: `Your exchange for ${r.rmaNumber}`,
      actorId: input.actorId,
    });
    if (rep) {
      await prisma.$transaction([
        prisma.return.update({ where: { id: r.id }, data: { status: 'RECEIVED', resolvedAt: now, replacementOrderId: rep.orderId } }),
        // The sale stands: the buyer keeps an identical item.
        prisma.orderItem.update({ where: { id: item.id }, data: { status: 'DELIVERED' } }),
      ]);
      return { outcome: 'EXCHANGED', replacementOrderNumber: rep.orderNumber };
    }
    const { amountPaise } = await refundClaim(r, `No identical ${label} is in stock, so your exchange is refunded instead`);
    await prisma.return.update({ where: { id: r.id }, data: { remedy: 'REFUND', resolvedAt: now } });
    return { outcome: 'REFUNDED', refundPaise: amountPaise, outOfStock: true };
  }

  const { amountPaise } = await refundClaim(r, `We received ${label} back and it passed quality check`);
  await prisma.return.update({ where: { id: r.id }, data: { resolvedAt: now } });
  return { outcome: 'REFUNDED', refundPaise: amountPaise };
}

/** The buyer self-shipped (pickup not serviceable): their courier receipt (7.2). */
export async function recordSelfShipReceipt(input: { returnId: string; userId: string; receipt: string; costPaise: number }) {
  const r = await prisma.return.findUnique({ where: { id: input.returnId } });
  if (!r || r.userId !== input.userId) throw ApiError.notFound('Return not found');
  if (!r.selfShip) throw ApiError.badRequest('This return is collected by the courier', 'NOT_SELF_SHIP');
  if (r.selfShipReimbursedAt) throw ApiError.badRequest('Already reimbursed', 'ALREADY_REIMBURSED');
  await prisma.return.update({ where: { id: r.id }, data: { selfShipReceipt: input.receipt, selfShipCostPaise: input.costPaise } });
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await prisma.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      type: 'RETURN_SELF_SHIP',
      title: `Self-ship receipt — ${r.rmaNumber}`,
      body: `The buyer sent the return themselves (₹${(input.costPaise / 100).toLocaleString('en-IN')}). Reimburse up to ₹100 from the returns desk.`,
      linkHref: '/admin/returns',
    })),
  });
}

/** An admin paid the buyer's courier charges (up to ₹100) by hand; the seller bears them. */
export async function reimburseSelfShip(input: { returnId: string; amountPaise: number; reference: string; adminId: string }) {
  const r = await prisma.return.findUnique({ where: { id: input.returnId }, include: { orderItem: true } });
  if (!r) throw ApiError.notFound('Return not found');
  if (!r.selfShip || !r.selfShipReceipt) throw ApiError.badRequest('No self-ship receipt on this return', 'NO_RECEIPT');
  if (r.selfShipReimbursedAt) throw ApiError.badRequest('Already reimbursed', 'ALREADY_REIMBURSED');
  const data: Prisma.ReturnUpdateInput = {
    selfShipReimbursedPaise: input.amountPaise,
    selfShipReimbursedAt: new Date(),
    selfShipReimburseRef: input.reference,
  };
  await prisma.return.update({ where: { id: r.id }, data });
  // The seller pays for the return's carriage (Return Policy 2.2).
  await postEntry({
    sellerId: r.orderItem.sellerId,
    type: 'RETURN_FREIGHT',
    bucket: 'SETTLEMENT',
    amountPaise: -input.amountPaise,
    orderId: r.orderItem.orderId,
    orderItemId: r.orderItem.id,
    idempotencyKey: `selfship:${r.id}`,
    note: `Return ${r.rmaNumber}: courier charges the buyer paid to send it back`,
    createdById: input.adminId,
  });
  await prisma.notification.create({
    data: {
      userId: r.userId,
      type: 'RETURN_SELF_SHIP_PAID',
      title: 'Courier charges reimbursed',
      body: `₹${(input.amountPaise / 100).toLocaleString('en-IN')} for sending back ${r.rmaNumber} has been paid to you (reference ${input.reference}).`,
      linkHref: '/account/returns',
    },
  });
}

/**
 * A buyer raising a claim (Return Policy 2–3): a listed reason, the evidence,
 * inside the time limit, and the remedy they want. The seller then decides
 * within their 48 hours, as for any return.
 */
export async function raiseClaim(userId: string, itemId: string, body: unknown): Promise<{ requested: true; rmaNumber: string }> {
  const input = claimRequestSchema.parse(body);
  await assertOwnAssets([...input.photos, ...input.tagPhotos, ...input.packagingPhotos], { ownerId: userId, purpose: 'RETURN_PHOTO' });
  if (input.unboxingVideo) await assertOwnAssets([input.unboxingVideo], { ownerId: userId, purpose: 'RETURN_VIDEO' });

  const item = await prisma.orderItem.findUnique({
    where: { id: itemId },
    include: {
      order: { select: { userId: true, orderNumber: true, paymentMethod: true } },
      seller: { select: { userId: true } },
      product: { select: { categoryId: true, nonReturnable: true } },
      return: true,
    },
  });
  if (!item || item.order.userId !== userId) throw ApiError.notFound('Item not found');
  if (item.status !== 'DELIVERED' || !item.deliveredAt) throw ApiError.badRequest('Only delivered items can be claimed for');
  if (item.return) throw ApiError.badRequest('A claim is already open for this item', 'ALREADY_CLAIMED');
  // Hygiene and customised items (5.1): only a wrong, counterfeit or non-conforming one.
  if (!(await orderLineReturnable(item)) && !CLAIM_REASONS_NON_RETURNABLE.includes(input.reason)) {
    throw ApiError.badRequest(
      'This item is not returnable, except if it is the wrong item, counterfeit, or materially different from its page',
      'NOT_RETURNABLE',
    );
  }
  const timing = claimTimingProblem({ reason: input.reason, deliveredAt: item.deliveredAt, latentNoticedAt: input.latentNoticedAt ?? null });
  if (timing) throw ApiError.badRequest(timing, 'CLAIM_WINDOW_CLOSED');
  if (input.remedy === 'EXCHANGE' && !(await exchangeAllowed(item.id, input.reason))) {
    throw ApiError.badRequest('This item was already exchanged for a defect, so a second defect is refunded', 'REFUND_ONLY');
  }
  // Cash on Delivery: any refund is a bank transfer to the buyer's own account (6.4).
  const cod = item.order.paymentMethod === 'COD';
  if (cod && !input.codRefundAccount) {
    throw ApiError.invalidField(
      'codRefundAccount.accountNumber',
      'Give the bank account (in your own name) for a refund — Cash on Delivery refunds are paid by bank transfer',
      'COD_REFUND_ACCOUNT_REQUIRED',
    );
  }

  const rmaNumber = await nextRmaNumber();
  await prisma.$transaction([
    prisma.return.create({
      data: {
        rmaNumber,
        rules: 'CLAIM',
        orderItemId: item.id,
        userId,
        reasonCategory: input.reason,
        reason: input.details ?? '',
        remedy: input.remedy,
        photos: input.photos,
        tagPhotos: input.tagPhotos,
        packagingPhotos: input.packagingPhotos,
        unboxingVideo: input.unboxingVideo ?? null,
        latentNoticedAt: input.latentNoticedAt ?? null,
        ...(cod && input.codRefundAccount
          ? {
              codRefundAccount: {
                create: {
                  method: 'BANK',
                  last4: input.codRefundAccount.accountNumber.slice(-4),
                  cipher: encryptCodRefundAccount(input.codRefundAccount),
                },
              },
            }
          : {}),
      },
    }),
    prisma.orderItem.update({ where: { id: item.id }, data: { status: 'RETURN_REQUESTED' } }),
    prisma.notification.create({
      data: {
        userId: item.seller.userId,
        type: 'RETURN_REQUESTED',
        title: `Claim ${rmaNumber}: ${CLAIM_REASON_LABELS[input.reason].toLowerCase()} ↩`,
        body: `The buyer of "${item.title}" (${item.order.orderNumber}) asks for ${input.remedy === 'EXCHANGE' ? 'an exchange' : 'a refund'}, with photos${input.unboxingVideo ? ' and an unboxing video' : ''}. Decide within 48 hours in Returns.`,
        linkHref: '/seller/returns',
      },
    }),
  ]);
  return { requested: true, rmaNumber };
}


/** A claim's evidence for the seller and the desk, with fresh URLs; null for an earlier-rules return. */
export async function claimEvidenceView(returnId: string, opts: { forAdmin?: boolean } = {}): Promise<ClaimEvidenceView | null> {
  const r = await prisma.return.findUnique({ where: { id: returnId }, include: { user: { select: { claimsReviewNote: true } } } });
  if (!r || r.rules !== 'CLAIM') return null;
  const [tagPhotos, packagingPhotos, [video, receipt]] = await Promise.all([
    resolveFileUrls(r.tagPhotos),
    resolveFileUrls(r.packagingPhotos),
    resolveFileUrls([r.unboxingVideo ?? '', r.selfShipReceipt ?? '']),
  ]);
  return {
    remedy: r.remedy === 'EXCHANGE' || r.remedy === 'REFUND' ? r.remedy : null,
    tagPhotos: tagPhotos.filter((u): u is string => !!u),
    packagingPhotos: packagingPhotos.filter((u): u is string => !!u),
    unboxingVideoUrl: video || null,
    latentNoticedAt: r.latentNoticedAt?.toISOString() ?? null,
    qcNote: r.qcNote,
    selfShip: r.selfShip ? { receiptUrl: receipt || null, costPaise: r.selfShipCostPaise, reimbursedPaise: r.selfShipReimbursedPaise } : null,
    ...(opts.forAdmin ? { buyerUnderReview: r.user.claimsReviewNote } : {}),
  };
}
