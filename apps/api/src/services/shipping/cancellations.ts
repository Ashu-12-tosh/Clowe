import { prisma } from '../../db';
import { shippingProvider } from './index';

// ---------------------------------------------------------------------------
// An order cancelled after it was booked: cancel the booking too.
//
// When every live line of a parcel is cancelled — by the buyer, the seller or
// an admin — its Delhivery booking is cancelled. Before pickup that is the end
// of it (the parcel is CANCELLED); once picked up, Delhivery brings it back to
// the seller, and its scans say so. A parcel with lines still live is left
// alone: a box can't be part-cancelled.
//
// The cancellation itself never waits on the courier. If Delhivery refuses,
// admins are told to cancel it by hand in Delhivery One (the mock courier,
// which forgets its bookings on restart, is not worth an alert).
// ---------------------------------------------------------------------------

const BEFORE_PICKUP = ['CREATED', 'PICKUP_REQUESTED'];
const ON_THE_WAY = ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED'];

export async function cancelShipmentsForLines(itemIds: string[]): Promise<number> {
  if (itemIds.length === 0) return 0;
  const lines = await prisma.orderItem.findMany({
    where: { id: { in: itemIds }, shipmentId: { not: null } },
    select: { shipmentId: true },
  });
  const shipmentIds = [...new Set(lines.map((l) => l.shipmentId!))];
  const shipments = await prisma.shipment.findMany({
    where: { id: { in: shipmentIds }, kind: 'FORWARD' },
    include: { items: { select: { status: true } }, order: { select: { orderNumber: true } } },
  });

  let cancelled = 0;
  for (const s of shipments) {
    if (!s.awbNumber) continue;
    if (s.items.some((i) => i.status !== 'CANCELLED')) continue;
    const beforePickup = BEFORE_PICKUP.includes(s.status);
    if (!beforePickup && !ON_THE_WAY.includes(s.status)) continue;
    try {
      await shippingProvider.cancelShipment(s.awbNumber);
      await prisma.shipment.update({
        where: { id: s.id },
        data: beforePickup
          ? { status: 'CANCELLED', cancelledAt: new Date(), statusText: 'Cancelled with Delhivery' }
          : { statusText: 'Cancelled — Delhivery is returning it to the seller' },
      });
      cancelled += 1;
    } catch (err) {
      console.error('[clowe-api] could not cancel shipment', s.awbNumber, err instanceof Error ? err.message : err);
      if (shippingProvider.name === 'mock') continue;
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
      await prisma.notification.createMany({
        data: admins.map((a) => ({
          userId: a.id,
          type: 'SHIPMENT_CANCEL_FAILED',
          title: `Cancel AWB ${s.awbNumber} on Delhivery by hand`,
          body: `Order ${s.order.orderNumber} was cancelled, but Delhivery refused to cancel its parcel: ${err instanceof Error ? err.message : 'no reason given'}. Cancel it in Delhivery One.`,
          linkHref: '/admin/orders',
        })),
      });
    }
  }
  return cancelled;
}

/** Never let the courier hold up a cancellation. */
export function cancelShipmentsForLinesSafe(itemIds: string[]): Promise<void> {
  return cancelShipmentsForLines(itemIds).then(
    () => undefined,
    (err) => console.error('[clowe-api] shipment cancellation failed', err),
  );
}
