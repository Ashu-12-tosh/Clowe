import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { sendToUserSafe } from './messaging';
import { paymentProvider } from './payments';
import { processRefund } from './refundService';
import type { SellerReturnActionInput } from '@clowe/shared';

/**
 * Next return-authorisation number, e.g. RMA-2026-000042. Numbering restarts
 * each year; the unique index is the real guard, so a clash just tries again.
 */
export async function nextRmaNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const startOfYear = new Date(year, 0, 1);
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
  } else {
    // action === 'received'
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
                provider: paymentProvider.name,
                status: 'PENDING',
              },
            }),
            prisma.notification.create({
              data: {
                userId: customer.id,
                type: 'REFUND_INITIATED',
                title: 'Refund initiated 💰',
                body: `We received ${label} back. Your refund of ₹${(refundPaise / 100).toFixed(2)} has been initiated — expect it within 5–7 business days.`,
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
    if (input.condition === 'OK' && refundRecord && 'returnId' in refundRecord) {
      await processRefund(refundRecord.id);
    }
  }

  return (await findSellerReturn(sellerId, r.id))!;
}
