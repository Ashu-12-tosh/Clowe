import { LOST_AFTER_ETA_DAYS, UNTRACEABLE_AFTER_DAYS, type LostParcelChoice } from '@clowe/shared';
import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { syncOrderStatus } from '../orderStatusService';
import { settleEarnedCredits } from '../purchaseCredits';
import { refundOrderPart } from '../refundService';
import { createReplacementOrder } from '../replacementOrder';
import { valueOfLines } from './codAmount';

// ---------------------------------------------------------------------------
// Lost in transit (Shipping Policy 9.2): a parcel not delivered within 15
// days of its estimated date and not traceable is treated as lost, and the
// buyer chooses a replacement or a full refund of what they paid.
//
// "Not traceable": no courier scan for 7 days. A parcel still being scanned
// is late (9.1), not lost. The courier saying "lost" flags it at once.
//
// The sweep only flags and asks; nothing is refunded or sent until the buyer
// chooses. Claiming the parcel from the courier stays with the admin.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const MOVING = ['PICKUP_REQUESTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED'] as const;

/** Flag one parcel lost and ask the buyer what they want. Once only. */
export async function flagShipmentLost(shipmentId: string, why: string): Promise<boolean> {
  const at = new Date();
  const moved = await prisma.shipment.updateMany({
    where: { id: shipmentId, kind: 'FORWARD', lostFlaggedAt: null },
    data: { lostFlaggedAt: at, status: 'LOST' },
  });
  if (moved.count === 0) return false;
  const shipment = await prisma.shipment.findUniqueOrThrow({
    where: { id: shipmentId },
    include: { order: { select: { id: true, userId: true, orderNumber: true } }, seller: { select: { userId: true } } },
  });
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await prisma.notification.createMany({
    data: [
      {
        userId: shipment.order.userId,
        type: 'SHIPMENT_LOST',
        title: `Your parcel is lost in transit — ${shipment.order.orderNumber}`,
        body: 'We are sorry. Choose a free replacement or a full refund of what you paid, from your order page.',
        linkHref: `/account/orders/${shipment.order.id}`,
      },
      {
        userId: shipment.seller.userId,
        type: 'SHIPMENT_LOST',
        title: `Parcel lost in transit — ${shipment.order.orderNumber}`,
        body: `AWB ${shipment.awbNumber ?? '—'}: ${why}. The buyer will choose a replacement or a refund; we will tell you which.`,
        linkHref: `/seller/orders/${shipment.order.id}`,
      },
      ...admins.map((a) => ({
        userId: a.id,
        type: 'SHIPMENT_LOST',
        title: `Parcel lost in transit — AWB ${shipment.awbNumber ?? '—'}`,
        body: `${why}. The buyer has been asked to choose a replacement or a refund. Claim it from the courier.`,
        linkHref: '/admin/shipments',
      })),
    ],
  });
  return true;
}

/** Parcels 15 days past their estimate and silent for 7: flag them. Returns how many. */
export async function sweepLostShipments(now: Date = new Date()): Promise<number> {
  const lateBefore = new Date(now.getTime() - LOST_AFTER_ETA_DAYS * DAY_MS);
  const silentBefore = new Date(now.getTime() - UNTRACEABLE_AFTER_DAYS * DAY_MS);
  const candidates = await prisma.shipment.findMany({
    where: {
      kind: 'FORWARD',
      lostFlaggedAt: null,
      status: { in: [...MOVING] },
      pickedUpAt: { not: null },
      OR: [{ etaTo: { lt: lateBefore } }, { etaTo: null, order: { etaTo: { lt: lateBefore } } }],
      AND: [{ OR: [{ lastScanAt: null }, { lastScanAt: { lt: silentBefore } }] }],
    },
    select: { id: true },
  });
  let flagged = 0;
  for (const s of candidates) {
    if (await flagShipmentLost(s.id, `${LOST_AFTER_ETA_DAYS} days past the estimated delivery date with no courier scan for ${UNTRACEABLE_AFTER_DAYS} days`)) flagged += 1;
  }
  return flagged;
}

export function startLostParcelSweep(): void {
  const run = () => {
    sweepLostShipments()
      .then((n) => {
        if (n > 0) console.log(`[clowe-api] parcels flagged lost in transit: ${n}`);
      })
      .catch((err) => console.error('[clowe-api] lost-parcel sweep failed:', err));
  };
  run();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref();
}

export interface LostChoiceResult {
  choice: LostParcelChoice;
  /** REPLACEMENT chosen but out of stock: refunded instead. */
  fellBackToRefund: boolean;
  replacement: { orderId: string; orderNumber: string } | null;
  refund: { id: string; status: string; amountPaise: number } | null;
}

/** The buyer's choice for a lost parcel: a replacement (if in stock) or a refund. Once only. */
export async function chooseLostOutcome(input: {
  orderId: string;
  shipmentId: string;
  userId: string;
  choice: LostParcelChoice;
}): Promise<LostChoiceResult> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: input.shipmentId },
    include: { order: { include: { items: true } }, items: true, seller: { select: { userId: true } } },
  });
  if (!shipment || shipment.orderId !== input.orderId || shipment.order.userId !== input.userId) {
    throw ApiError.notFound('Parcel not found');
  }
  if (!shipment.lostFlaggedAt) throw ApiError.badRequest('This parcel is not marked lost', 'NOT_LOST');
  if (shipment.lostChoice) throw ApiError.badRequest('You have already chosen for this parcel', 'ALREADY_CHOSEN');
  const claimed = await prisma.shipment.updateMany({
    where: { id: shipment.id, lostChoice: null },
    data: { lostChoice: input.choice, lostChoiceAt: new Date() },
  });
  if (claimed.count === 0) throw ApiError.badRequest('You have already chosen for this parcel', 'ALREADY_CHOSEN');

  const lines = shipment.items.filter((i) => i.status === 'SHIPPED');
  const order = shipment.order;
  let replacement: LostChoiceResult['replacement'] = null;
  if (input.choice === 'REPLACEMENT' && lines.length > 0) {
    replacement = await createReplacementOrder({
      orderId: order.id,
      itemIds: lines.map((l) => l.id),
      reason: 'Your parcel was lost in transit',
    });
  }
  const fellBackToRefund = input.choice === 'REPLACEMENT' && !replacement;
  if (fellBackToRefund) {
    await prisma.shipment.update({ where: { id: shipment.id }, data: { lostChoice: 'REFUND' } });
  }

  // The lost lines are closed either way: replaced, or refunded.
  await prisma.orderItem.updateMany({
    where: { id: { in: lines.map((l) => l.id) }, status: 'SHIPPED' },
    data: { status: 'CANCELLED' },
  });
  await syncOrderStatus(order.id);

  let refund: LostChoiceResult['refund'] = null;
  if (!replacement && lines.length > 0) {
    // Everything paid for these lines, shipping included (it is ₹0). Nothing
    // on a COD parcel that never arrived: nothing was paid.
    const paid = valueOfLines(order.totalPaise, order.items, lines.map((l) => l.id));
    refund = await refundOrderPart(order.id, paid, 'Lost in transit');
    await settleEarnedCredits(order.id);
  }

  await prisma.notification.create({
    data: {
      userId: shipment.seller.userId,
      type: 'SHIPMENT_LOST',
      title: `Lost parcel — the buyer chose ${replacement ? 'a replacement' : 'a refund'}`,
      body: replacement
        ? `Ship the same items again as ${replacement.orderNumber}.`
        : `Order ${order.orderNumber}: the lost items are refunded to the buyer.`,
      linkHref: replacement ? '/seller/orders' : `/seller/orders/${order.id}`,
    },
  });
  return {
    choice: replacement ? 'REPLACEMENT' : 'REFUND',
    fellBackToRefund,
    replacement: replacement ? { orderId: replacement.orderId, orderNumber: replacement.orderNumber } : null,
    refund,
  };
}
