import { MAX_DELIVERY_ATTEMPTS, trackDay } from '@clowe/shared';
import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { creditExpiryFrom } from '../../routes/credits';
import { refundOrderPart } from '../refundService';
import { inLockOrder, returnStock } from '../stockService';
import { valueOfLines } from './codAmount';
import { shippingProvider } from './index';
import { ShippingProviderError, type NdrAction } from './ShippingProvider';
import { sendOrderSms } from '../messaging/orderSms';

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
  sendOrderSms('RTO', order.shipPhone, { orderNumber: order.orderNumber });
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
        body: `Delhivery couldn't deliver AWB ${shipment.awbNumber ?? '—'} and is returning it to your return address (your pickup address if you haven't set one). Check it when it arrives.`,
        linkHref: `/seller/orders/${order.id}`,
      },
    ],
  });
}

/** Tell the seller and the buyer about a failed delivery attempt. */
export async function notifyFailedAttempt(
  shipment: { orderId: string; sellerId: string; awbNumber: string | null },
  reason: string,
  attempt = 1,
): Promise<void> {
  const last = attempt >= MAX_DELIVERY_ATTEMPTS;
  const ofMax = `attempt ${Math.min(attempt, MAX_DELIVERY_ATTEMPTS)} of ${MAX_DELIVERY_ATTEMPTS}`;
  const order = await prisma.order.findUniqueOrThrow({ where: { id: shipment.orderId }, select: { id: true, userId: true, orderNumber: true, shipPhone: true } });
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: shipment.sellerId }, select: { userId: true } });
  sendOrderSms('DELIVERY_FAILED', order.shipPhone, { orderNumber: order.orderNumber, reason });
  await prisma.notification.createMany({
    data: [
      {
        userId: seller.userId,
        type: 'SELLER_NDR',
        title: `Delivery attempt failed (${ofMax}) — ${order.orderNumber}`,
        body: last
          ? `${reason}. That was the last attempt: the parcel will come back to you.`
          : `${reason}. Ask Delhivery to try again, or to deliver on another day, from the order page.`,
        linkHref: `/seller/orders/${order.id}`,
      },
      {
        userId: order.userId,
        type: 'ORDER_NDR',
        title: `We missed you (${ofMax}) — ${order.orderNumber}`,
        body: last
          ? `Delhivery couldn't deliver (${reason.toLowerCase()}). That was the last of ${MAX_DELIVERY_ATTEMPTS} attempts, so the parcel goes back to the seller; anything you paid is refunded in full.`
          : `Delhivery couldn't deliver today (${reason.toLowerCase()}). It will try again — up to ${MAX_DELIVERY_ATTEMPTS} attempts in all; reply to the courier's call or contact support to change the date.`,
        linkHref: `/account/orders/${order.id}`,
      },
    ],
  });
}

/** Out for delivery: the buyer hears once per trip — once per day the courier sets out with it. */
export async function notifyOutForDelivery(shipment: { id: string; orderId: string; awbNumber: string | null }, at: Date = new Date()): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: shipment.orderId }, select: { id: true, userId: true, orderNumber: true, shipPhone: true } });
  const day = trackDay(at);
  const awb = shipment.awbNumber ?? '—';
  // Back at the hub and out again the same day is the same trip.
  const already = await prisma.notification.count({
    where: { userId: order.userId, type: 'ORDER_OUT_FOR_DELIVERY', body: { contains: `AWB ${awb}) is out for delivery on ${day}` } },
  });
  if (already > 0) return;
  await prisma.notification.create({
    data: {
      userId: order.userId,
      type: 'ORDER_OUT_FOR_DELIVERY',
      title: `Out for delivery — ${order.orderNumber}`,
      body: `Your parcel (Delhivery AWB ${awb}) is out for delivery on ${day}. Keep your phone handy: the courier calls before coming.`,
      linkHref: `/account/orders/${order.id}`,
    },
  });
  sendOrderSms('OUT_FOR_DELIVERY', order.shipPhone, { orderNumber: order.orderNumber, awb: shipment.awbNumber ?? '' });
}

/** The parcel is back with the seller: ask them to check it. */
export async function notifyRtoArrived(shipment: { orderId: string; sellerId: string; awbNumber: string | null }): Promise<void> {
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: shipment.sellerId }, select: { userId: true } });
  await prisma.notification.create({
    data: {
      userId: seller.userId,
      type: 'SELLER_RTO_BACK',
      title: 'An undelivered parcel is back with you',
      body: `AWB ${shipment.awbNumber ?? '—'} is back with you. Check it on the order page: in good condition, its stock goes back on sale.`,
      linkHref: `/seller/orders/${shipment.orderId}`,
    },
  });
}

/**
 * After a failed delivery attempt, ask Delhivery to:
 * - RE_ATTEMPT — try again;
 * - DEFER_DELIVERY — deliver on a later day (up to six days out);
 * - EDIT_DETAILS — deliver to a corrected address (same PIN code: Delhivery
 *   re-routes only within it) or phone;
 * - RETURN_TO_SELLER — give up and bring it back (Delhivery's cancellation of
 *   a parcel on its way is a return to origin; its RTO scans then refund a
 *   prepaid buyer as usual).
 */
export async function requestNdrAction(input: {
  shipmentId: string;
  sellerId?: string;
  action: NdrAction | 'RETURN_TO_SELLER';
  deferTo?: Date;
  consignee?: { line1?: string; line2?: string | null; phone?: string };
}): Promise<{ requestId: string | null }> {
  const shipment = await prisma.shipment.findUnique({ where: { id: input.shipmentId }, include: { order: { select: { id: true, userId: true, orderNumber: true } } } });
  if (!shipment || (input.sellerId && shipment.sellerId !== input.sellerId)) throw ApiError.notFound('Parcel not found');
  if (shipment.status !== 'DELIVERY_FAILED' || !shipment.awbNumber) {
    throw ApiError.badRequest('Only a parcel whose delivery attempt failed can be acted on this way', 'NOT_AN_NDR');
  }
  if (input.action === 'DEFER_DELIVERY') {
    const days = input.deferTo ? (input.deferTo.getTime() - Date.now()) / 86_400_000 : -1;
    if (days < 0 || days > 6) throw ApiError.badRequest('Pick a day within the next six days', 'NDR_BAD_DATE');
  }
  const line1 = input.consignee?.line1?.trim();
  const phone = input.consignee?.phone?.trim();
  if (input.action === 'EDIT_DETAILS' && !line1 && !phone) {
    throw ApiError.badRequest('Give the corrected address or phone', 'NDR_NO_DETAILS');
  }
  try {
    if (input.action === 'RETURN_TO_SELLER') {
      await shippingProvider.cancelShipment(shipment.awbNumber);
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { ndrAction: 'RETURN_TO_SELLER', ndrRequestId: null, ndrActionAt: new Date(), statusText: 'Return to the seller requested' },
      });
      return { requestId: null };
    }
    const address = line1 ? [line1, input.consignee?.line2?.trim()].filter(Boolean).join(', ') : undefined;
    const { requestId } = await shippingProvider.ndrAction(shipment.awbNumber, {
      action: input.action,
      deferTo: input.deferTo,
      ...(input.action === 'EDIT_DETAILS' ? { consignee: { ...(address ? { line1: address } : {}), ...(phone ? { phone } : {}) } } : {}),
    });
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { ndrAction: input.action, ndrRequestId: requestId, ndrActionAt: new Date() },
    });
    if (input.action === 'EDIT_DETAILS') {
      await prisma.notification.create({
        data: {
          userId: shipment.order.userId,
          type: 'ORDER_NDR',
          title: `Delivery details updated — ${shipment.order.orderNumber}`,
          body: `Delhivery will try again${address ? ` at ${address}` : ''}${phone ? `${address ? ',' : ''} calling ${phone.slice(0, 2)}xxxxxx${phone.slice(-2)}` : ''}.`,
          linkHref: `/account/orders/${shipment.order.id}`,
        },
      });
    }
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
      for (const l of inLockOrder(lines)) {
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
