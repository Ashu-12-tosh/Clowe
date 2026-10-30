import { dispatchedEtaWindow } from '@clowe/shared';
import { prisma } from '../../db';
import { sendMessageSafe } from '../messaging';
import { sendOrderSms } from '../messaging/orderSms';
import { chargeLateDispatchIfDue } from '../lateDispatch';
import { settleCodIfDelivered, syncOrderStatus } from '../orderStatusService';
import { postDeliveryEntries } from '../sellerLedgerService';
import { checkSellerReferralReward } from '../sellerReferralService';
import { syncShipmentsFromLines } from './shipments';

// ---------------------------------------------------------------------------
// A line leaving with the courier, and reaching the buyer — one definition,
// whoever reports it: the seller's buttons on the mock courier, an admin, or
// Delhivery's own scans. Each moves only a line in the stage before it, so a
// replayed scan or a double click changes nothing the second time.
// ---------------------------------------------------------------------------

const lineWith = (id: string) =>
  prisma.orderItem.findUnique({
    where: { id },
    include: { order: { include: { user: { select: { id: true, phone: true } } } } },
  });

/** Picked up: the line is shipped, at the time the courier collected it. Returns false if it wasn't waiting to go. */
export async function markLineShipped(itemId: string, at: Date = new Date()): Promise<boolean> {
  const item = await lineWith(itemId);
  if (!item || (item.status !== 'CONFIRMED' && item.status !== 'PACKED')) return false;
  const moved = await prisma.orderItem.updateMany({
    where: { id: item.id, status: { in: ['CONFIRMED', 'PACKED'] } },
    data: { status: 'SHIPPED', shippedAt: at },
  });
  if (moved.count === 0) return false;
  // The estimate from dispatch, by the destination's zone (Shipping Policy 3.2).
  if (item.shipmentId) {
    const eta = dispatchedEtaWindow(item.order.shipPincode, at);
    await prisma.shipment.updateMany({
      where: { id: item.shipmentId, etaTo: null },
      data: { etaFrom: eta.from, etaTo: eta.to },
    });
  }
  await prisma.notification.create({
    data: {
      userId: item.order.user.id,
      type: 'ITEM_SHIPPED',
      title: 'Your order is on its way 🚚',
      body: `"${item.title}" (${item.order.orderNumber}) shipped via ${item.courierName ?? 'Delhivery'} — AWB ${item.awbNumber ?? '—'}.`,
      linkHref: `/account/orders/${item.orderId}`,
    },
  });
  sendMessageSafe({
    channel: 'whatsapp',
    to: `+91${item.order.user.phone}`,
    body: `Your Clowe item "${item.title}" has shipped via ${item.courierName ?? 'Delhivery'} (AWB ${item.awbNumber ?? '—'}). Track: /track 🚚`,
  });
  sendOrderSms('SHIPPED', item.order.shipPhone, { orderNumber: item.order.orderNumber, awb: item.awbNumber ?? '' });
  await syncShipmentsFromLines([item.shipmentId]);
  await syncOrderStatus(item.orderId);
  // Shipped after the penalty deadline? Charged here if the sweep has not
  // already; once per order either way.
  await chargeLateDispatchIfDue(item.orderId, item.sellerId);
  return true;
}

/** Delivered to the buyer: the money is earned. Returns false if it wasn't on its way. */
export async function markLineDelivered(itemId: string, at: Date = new Date()): Promise<boolean> {
  const item = await lineWith(itemId);
  if (!item || item.status !== 'SHIPPED') return false;
  const moved = await prisma.orderItem.updateMany({
    where: { id: item.id, status: 'SHIPPED' },
    data: { status: 'DELIVERED', deliveredAt: at },
  });
  if (moved.count === 0) return false;
  await prisma.notification.create({
    data: {
      userId: item.order.user.id,
      type: 'ITEM_DELIVERED',
      title: 'Delivered! 📦',
      body: `"${item.title}" (${item.order.orderNumber}) has been delivered. We'd love a review!`,
      linkHref: `/account/orders/${item.orderId}`,
    },
  });
  sendOrderSms('DELIVERED', item.order.shipPhone, { orderNumber: item.order.orderNumber });
  await syncShipmentsFromLines([item.shipmentId]);
  await syncOrderStatus(item.orderId);
  await settleCodIfDelivered(item.orderId);
  // Delivery is the moment the money is earned: it goes on the ledger here,
  // once, however many times this line is replayed.
  await postDeliveryEntries(item.id);
  checkSellerReferralReward(item.sellerId).catch((err) =>
    console.error('[clowe-api] referral reward check failed:', err),
  );
  return true;
}
