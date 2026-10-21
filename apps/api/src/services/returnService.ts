import { bookReversePickupSafe } from './shipping/reversePickup';
import { prisma } from '../db';
import { issueCreditNoteSafe } from './creditNotes';
import { ApiError } from '../utils/ApiError';
import { sendToUserSafe } from './messaging';
import { paymentProvider } from './payments';
import { MANUAL_COD_PROVIDER, processRefund } from './refundService';
import { postReturnReversal } from './sellerLedgerService';
import { settleEarnedCredits } from './purchaseCredits';
import { settleClaimAfterQc } from './returnClaims';
import { istDate, istDayStart, RETURN_NOT_BACK_MESSAGE, returnItemBack, type SellerReturnActionInput } from '@clowe/shared';

/**
 * Next return-authorisation number, e.g. RMA-2026-000042. Numbering restarts
 * each year; the unique index is the real guard, so a clash just tries again.
 */
export async function nextRmaNumber(): Promise<string> {
  const year = istDate(new Date()).year;
  const startOfYear = istDayStart(year, 0);
  const soFar = await prisma.return.count({ where: { createdAt: { gte: startOfYear } } });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `RMA-${year}-${String(soFar + 1 + attempt).padStart(6, '0')}`;
    const exists = await prisma.return.findUnique({ where: { rmaNumber: candidate } });
    if (!exists) return candidate;
  }
  throw new Error('Could not allocate an RMA number');
}

/** One of the seller's returns, with everything a decision needs. */
export function findSellerReturn(sellerId: string, id: string) {
  return prisma.return.findFirst({
    where: { id, orderItem: { sellerId } },
    include: {
      refund: true,
      reverseShipment: { select: { awbNumber: true, status: true } },
      orderItem: {
        include: {
          order: { select: { orderNumber: true, shipName: true } },
          product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
        },
      },
    },
  });
}

export type SellerReturnRecord = NonNullable<Awaited<ReturnType<typeof findSellerReturn>>>;

/** What returnItemBack needs, from a seller's return. */
export function itemBackFacts(r: SellerReturnRecord) {
  return {
    pickupStatus: r.reverseShipment?.status ?? null,
    selfShip: r.selfShip,
    selfShipReceipt: !!r.selfShipReceipt,
    pickedUp: !!r.pickedUpAt,
  };
}

/**
 * Approve / reject / mark-received on one return. Shared by the single-row
 * action and the bulk bar, so both walk the identical state machine.
 */
export async function applyReturnDecision(
  sellerId: string,
  returnId: string,
  input: SellerReturnActionInput,
): Promise<SellerReturnRecord> {
  const r = await findSellerReturn(sellerId, returnId);
  if (!r) throw ApiError.notFound('Return not found');

  const item = await prisma.orderItem.findUnique({
    where: { id: r.orderItemId },
    include: { order: { include: { user: { select: { id: true, phone: true } } } } },
  });
  if (!item) throw ApiError.notFound('Order item not found');
  const customer = item.order.user;
  const label = `"${item.title}" (${item.order.orderNumber})`;

  // The check is of an item in the seller's hands, never one still with the buyer.
  if (input.action === 'received' && r.status === 'APPROVED' && !returnItemBack(itemBackFacts(r))) {
    throw ApiError.badRequest(RETURN_NOT_BACK_MESSAGE, 'RETURN_NOT_RECEIVED');
  }

  if (input.action === 'approve') {
    if (r.status !== 'REQUESTED') {
      throw ApiError.badRequest(`Cannot approve a return in status ${r.status}`);
    }
    await prisma.$transaction([
      prisma.return.update({
        where: { id: r.id },
        data: { status: 'APPROVED', approvedAt: new Date() },
      }),
      prisma.notification.create({
        data: {
          userId: customer.id,
          type: 'RETURN_APPROVED',
          title: 'Return approved ✅',
          body: `Your return for ${label} is approved. Pickup will be scheduled shortly — please keep the item packed.`,
        },
      }),
    ]);
    sendToUserSafe(
      customer.id,
      {
        channel: 'whatsapp',
        to: `+91${customer.phone}`,
        body: `Clowe: your return for ${label} is approved. Pickup will be scheduled shortly. ✅`,
      },
      { critical: true },
    );
    // Delhivery collects it from the buyer and brings it to the seller.
    await bookReversePickupSafe(r.id);
  } else if (input.action === 'reject') {
    if (r.status !== 'REQUESTED') {
      throw ApiError.badRequest(`Cannot reject a return in status ${r.status}`);
    }
    await prisma.$transaction([
      prisma.return.update({
        where: { id: r.id },
        data: {
          status: 'REJECTED',
          rejectionReason: input.rejectionReason,
          rejectedAt: new Date(),
          resolvedAt: new Date(),
        },
      }),
      // The item goes back to DELIVERED (the return did not happen).
      prisma.orderItem.update({ where: { id: item.id }, data: { status: 'DELIVERED' } }),
      prisma.notification.create({
        data: {
          userId: customer.id,
          type: 'RETURN_REJECTED',
          title: 'Return request declined',
          body: `Your return for ${label} was declined: "${input.rejectionReason}". If you disagree, raise a complaint from Support and our team will review it.`,
        },
      }),
    ]);
    sendToUserSafe(
      customer.id,
      {
        channel: 'whatsapp',
        to: `+91${customer.phone}`,
        body: `Clowe: your return for ${label} was declined — ${input.rejectionReason}`,
      },
      { critical: true },
    );
  } else if (r.rules === 'CLAIM') {
    // A Return Policy claim: the check decides exchange, refund or send-back.
    await settleClaimAfterQc({
      returnId: r.id,
      passed: input.condition === 'OK',
      note: input.note ?? null,
      actorId: null,
    });
  } else {
    // action === 'received' (a return under the earlier rules)
    if (r.status !== 'APPROVED') {
      throw ApiError.badRequest(`Cannot mark received a return in status ${r.status}`);
    }
    const refundPaise = item.pricePaise * item.quantity;
    const [, , refundRecord] = await prisma.$transaction([
      prisma.return.update({
        where: { id: r.id },
        data: {
          status: 'RECEIVED',
          receivedAt: new Date(),
          receivedCondition: input.condition,
          ...(input.condition === 'DAMAGED' ? { resolvedAt: new Date() } : {}),
        },
      }),
      prisma.orderItem.update({ where: { id: item.id }, data: { status: 'RETURNED' } }),
      // Refund only when the item came back in OK condition.
      ...(input.condition === 'OK'
        ? [
            prisma.refund.create({
              data: {
                returnId: r.id,
                orderId: item.orderId,
                amountPaise: refundPaise,
                // Cash on Delivery: a bank transfer an admin makes by hand.
                provider: item.order.paymentMethod === 'COD' ? MANUAL_COD_PROVIDER : paymentProvider.name,
                status: 'PENDING',
              },
            }),
            prisma.notification.create({
              data: {
                userId: customer.id,
                type: 'REFUND_INITIATED',
                title: 'Refund initiated 💰',
                body:
                  item.order.paymentMethod === 'COD'
                    ? `We received ${label} back. We will transfer your refund of ₹${(refundPaise / 100).toFixed(2)} to the bank account you gave, and tell you as soon as it is sent.`
                    : `We received ${label} back. Your refund of ₹${(refundPaise / 100).toFixed(2)} has been initiated — expect it within 5–7 business days.`,
              },
            }),
          ]
        : [
            prisma.notification.create({
              data: {
                userId: customer.id,
                type: 'RETURN_RECEIVED',
                title: 'Return received',
                body: `${label} reached the seller, but was flagged as damaged on arrival. Our support team will contact you — you can also raise a complaint from Support.`,
              },
            }),
          ]),
    ]);
    // The line is RETURNED whatever its condition, so its earning comes off
    // the seller's ledger either way; a damaged return is a support matter.
    await postReturnReversal(item.id);
    await issueCreditNoteSafe(item.id);
    await settleEarnedCredits(item.orderId);
    if (input.condition === 'OK' && refundRecord && 'returnId' in refundRecord) {
      await processRefund(refundRecord.id);
    }
  }

  return (await findSellerReturn(sellerId, r.id))!;
}
