import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { creditExpiryFrom } from '../../routes/credits';
import { refundOrderPart } from '../refundService';
import { returnStock } from '../stockService';
import { valueOfLines } from './codAmount';
import { shippingProvider } from './index';
import { ShippingProviderError, type NdrAction } from './ShippingProvider';

// ---------------------------------------------------------------------------
// When delivery goes wrong.
//
// A failed attempt (NDR): the seller and the buyer hear at once, and the
// seller — or an admin — can ask Delhivery to try again or to deliver on a
// later day. After repeated failures Delhivery sends the parcel back (RTO).
//
// When it starts coming back: the buyer's RTO count goes up (shown to sellers
// and admins, never blocking anything), a prepaid buyer is refunded what they
// paid for the parcel, and both are told. When it is back with the seller,
// they check it: in good condition its stock goes back on sale; damaged, an
// admin is told. The courier charges are posted by freight.ts.
// ---------------------------------------------------------------------------

type ShipmentForRto = { id: string; orderId: string; sellerId: string; awbNumber: string | null; items: { id: string }[] };

/** The parcel has started back to the seller: once per parcel, however often called. */
export async function startRto(shipment: ShipmentForRto, at: Date = new Date()): Promise<void> {
  // Claim the moment, so a replayed scan can't count or refund twice.
  const claimed = await prisma.shipment.updateMany({
    where: { id: shipment.id, rtoInitiatedAt: null },
    data: { rtoInitiatedAt: at },
  });
  if (claimed.count === 0) return;

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: shipment.orderId },
    include: { items: { select: { id: true, pricePaise: true, quantity: true, promoDiscountPaise: true, status: true } } },
  });
  await prisma.user.update({ where: { id: order.userId }, data: { rtoCount: { increment: 1 } } });

  const lineIds = shipment.items.map((i) => i.id);
  const refund =
    order.paymentMethod === 'COD'
      ? null
      : await refundOrderPart(
          order.id,
          valueOfLines(order.totalPaise, order.items, lineIds),
          `Couldn't be delivered — returned to the seller (AWB ${shipment.awbNumber ?? '—'})`,
        );
  // Nothing on the order was bought after all (every other line cancelled or
  // undelivered too): the coupon and the shopping credits come back, as they
  // do when an order is cancelled.
  const emptied = order.items
    .filter((i) => !lineIds.includes(i.id))
    .every((i) => i.status === 'CANCELLED' || i.status === 'RTO_IN_TRANSIT' || i.status === 'RTO_DELIVERED');
  if (emptied) {
    await prisma.$transaction([
      ...(order.couponCode && order.couponDiscountPaise > 0
        ? [prisma.coupon.updateMany({ where: { code: order.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } })]
        : []),
      ...(order.creditsUsed > 0
        ? [
            prisma.user.update({ where: { id: order.userId }, data: { creditsBalance: { increment: order.creditsUsed } } }),
            prisma.creditLedger.create({
              data: { userId: order.userId, delta: order.creditsUsed, reason: 'REFUND_CREDITS', orderId: order.id, expiresAt: creditExpiryFrom() },
            }),
          ]
        : []),
    ]);
  }

  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: shipment.sellerId }, select: { userId: true } });
  await prisma.notification.createMany({
    data: [
      {
        userId: order.userId,
        type: 'ORDER_RTO',
        title: `Order ${order.orderNumber} couldn't be delivered`,
        body: refund
          ? `Delhivery is returning it to the seller. Your refund of ₹${(refund.amountPaise / 100).toFixed(2)} is on its way.`
          : 'Delhivery is returning it to the seller. Nothing is due from you.',
        linkHref: `/account/orders/${order.id}`,
      },
      {
        userId: seller.userId,
        type: 'SELLER_RTO',
        title: `Parcel coming back — ${order.orderNumber}`,
        body: `Delhivery couldn't deliver AWB ${shipment.awbNumber ?? '—'} and is returning it to your pickup address. Check it when it arrives.`,
        linkHref: `/seller/orders/${order.id}`,
      },
    ],
  });
}

/** Tell the seller and the buyer about a failed delivery attempt. */
export async function notifyFailedAttempt(shipment: { orderId: string; sellerId: string; awbNumber: string | null }, reason: string): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: shipment.orderId }, select: { id: true, userId: true, orderNumber: true } });
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: shipment.sellerId }, select: { userId: true } });
  await prisma.notification.createMany({
    data: [
      {
        userId: seller.userId,
        type: 'SELLER_NDR',
        title: `Delivery attempt failed — ${order.orderNumber}`,
        body: `${reason}. Ask Delhivery to try again, or to deliver on another day, from the order page.`,
        linkHref: `/seller/orders/${order.id}`,
      },
      {
        userId: order.userId,
        type: 'ORDER_NDR',
        title: `We missed you — ${order.orderNumber}`,
        body: `Delhivery couldn't deliver today (${reason.toLowerCase()}). It will try again; reply to the courier's call or contact support to change the date.`,
        linkHref: `/account/orders/${order.id}`,
      },
    ],
  });
}

/** The parcel is back at the seller's pickup address: ask them to check it. */
export async function notifyRtoArrived(shipment: { orderId: string; sellerId: string; awbNumber: string | null }): Promise<void> {
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: shipment.sellerId }, select: { userId: true } });
  await prisma.notification.create({
    data: {
      userId: seller.userId,
      type: 'SELLER_RTO_BACK',
      title: 'An undelivered parcel is back with you',
      body: `AWB ${shipment.awbNumber ?? '—'} is back at your pickup address. Check it on the order page: in good condition, its stock goes back on sale.`,
      linkHref: `/seller/orders/${shipment.orderId}`,
    },
  });
}

/** Ask Delhivery to re-attempt, or to deliver on a later day (up to six days out). */
export async function requestNdrAction(input: {
  shipmentId: string;
  sellerId?: string;
  action: Extract<NdrAction, 'RE_ATTEMPT' | 'DEFER_DELIVERY'>;
  deferTo?: Date;
}): Promise<{ requestId: string }> {
  const shipment = await prisma.shipment.findUnique({ where: { id: input.shipmentId } });
  if (!shipment || (input.sellerId && shipment.sellerId !== input.sellerId)) throw ApiError.notFound('Parcel not found');
  if (shipment.status !== 'DELIVERY_FAILED' || !shipment.awbNumber) {
    throw ApiError.badRequest('Only a parcel whose delivery attempt failed can be re-attempted or deferred', 'NOT_AN_NDR');
  }
  if (input.action === 'DEFER_DELIVERY') {
    const days = input.deferTo ? (input.deferTo.getTime() - Date.now()) / 86_400_000 : -1;
    if (days < 0 || days > 6) throw ApiError.badRequest('Pick a day within the next six days', 'NDR_BAD_DATE');
  }
  try {
    const { requestId } = await shippingProvider.ndrAction(shipment.awbNumber, { action: input.action, deferTo: input.deferTo });
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { ndrAction: input.action, ndrRequestId: requestId, ndrActionAt: new Date() },
    });
    return { requestId };
  } catch (err) {
    if (err instanceof ShippingProviderError) throw ApiError.badRequest(`Delhivery: ${err.message}`, err.code);
    throw err;
  }
}

/**
 * The seller has the parcel back and has checked it. In good condition its
 * units go back on sale; damaged, an admin is told and nothing is restocked.
 * Once per parcel.
 */
export async function receiveRto(input: { shipmentId: string; sellerId: string; condition: 'GOOD' | 'DAMAGED'; actorId: string }): Promise<void> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: input.shipmentId },
    include: { items: true, order: { select: { orderNumber: true } } },
  });
  if (!shipment || shipment.sellerId !== input.sellerId) throw ApiError.notFound('Parcel not found');
  if (shipment.status !== 'RTO_DELIVERED') throw ApiError.badRequest('This parcel is not back with you yet', 'NOT_RETURNED');
  const claimed = await prisma.shipment.updateMany({
    where: { id: shipment.id, rtoReceivedAt: null },
    data: { rtoReceivedAt: new Date(), rtoReceivedCondition: input.condition },
  });
  if (claimed.count === 0) throw ApiError.badRequest('Already checked', 'ALREADY_RECEIVED');

  const lines = shipment.items.filter((i) => i.status === 'RTO_DELIVERED');
  if (input.condition === 'GOOD') {
    await prisma.$transaction(async (tx) => {
      for (const l of lines) {
        await tx.productVariant.update({ where: { id: l.variantId }, data: { stock: { increment: l.quantity } } });
        await returnStock(tx, {
          variantId: l.variantId,
          quantity: l.quantity,
          reason: `Returned undelivered (RTO), in good condition — AWB ${shipment.awbNumber ?? '—'}`,
          reference: shipment.order.orderNumber,
          actorId: input.actorId,
        });
      }
    });
    return;
  }
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await prisma.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      type: 'RTO_DAMAGED',
      title: `RTO parcel came back damaged — ${shipment.order.orderNumber}`,
      body: `The seller reports AWB ${shipment.awbNumber ?? '—'} came back damaged. Review it, and raise it with Delhivery if needed.`,
      linkHref: '/admin/orders',
    })),
  });
}
