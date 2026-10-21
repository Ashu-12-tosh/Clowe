import { dispatchSlaDeadline } from '@clowe/shared';
import { prisma } from '../db';
import { enqueueEmail } from './email';
import { getSettings } from './settingsService';

// ---------------------------------------------------------------------------
// A seller's new order: the bell, and an email (pre-launch audit 2026-10-21,
// M4). The email used to depend on the generic notification bridge, which
// needs an address on the seller's *account* — registration never asks for
// one, so most sellers heard of an order only if they happened to open the
// dashboard, with an 18-hour dispatch promise running. Now each seller gets
// their lines, the payment, and the time to ship by, at their account email
// or else their store's contact email; and the bell opens the order itself.
// ---------------------------------------------------------------------------

interface NewOrder {
  id: string;
  orderNumber: string;
  createdAt: Date;
  items: { sellerId: string; title: string; variantLabel?: string | null; size: string; color: string; quantity: number; pricePaise: number }[];
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** "21 Oct, 7:04 am" in India time. */
function istWhen(at: Date): string {
  return at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

export async function notifySellersOfNewOrder(order: NewOrder, cod: boolean): Promise<void> {
  const sellerIds = [...new Set(order.items.map((i) => i.sellerId))];
  const [sellers, settings] = await Promise.all([
    prisma.sellerProfile.findMany({
      where: { id: { in: sellerIds } },
      select: { id: true, userId: true, shopName: true, storeEmail: true, user: { select: { email: true } } },
    }),
    getSettings(),
  ]);
  const shipBy = istWhen(dispatchSlaDeadline(order.createdAt, settings.dispatchSlaHours));
  const link = `/seller/orders/${order.id}`;
  const title = cod ? 'New COD order received 🛍' : 'New order received 🛍';

  for (const s of sellers) {
    const lines = order.items.filter((i) => i.sellerId === s.id);
    const units = lines.reduce((n, l) => n + l.quantity, 0);
    const value = lines.reduce((n, l) => n + l.pricePaise * l.quantity, 0);
    const payment = cod ? `Cash on Delivery — the courier collects ${rupees(value)} on handover.` : 'Paid online.';
    const bell = `${order.orderNumber}: ${units} item${units === 1 ? '' : 's'} to ship by ${shipBy}. ${payment}`;
    await prisma.notification.create({ data: { userId: s.userId, type: 'NEW_ORDER', title, body: bell, linkHref: link } });

    const to = s.user.email || s.storeEmail;
    if (!to) continue;
    const list = lines
      .map((l) => {
        const option = l.variantLabel || [l.color, l.size].filter(Boolean).join(' / ');
        return `• ${l.title}${option ? ` (${option})` : ''} × ${l.quantity} — ${rupees(l.pricePaise * l.quantity)}`;
      })
      .join('\n');
    await enqueueEmail({
      to,
      userId: s.userId,
      kind: 'NEW_ORDER',
      dedupeKey: `new-order:${order.id}:${s.id}`,
      subject: `New order ${order.orderNumber} — ship by ${shipBy} — Clowe`,
      title: `New order ${order.orderNumber}`,
      body: [
        `${s.shopName}, you have a new order to pack and ship.`,
        list,
        payment,
        `Ship by ${shipBy} (India time): record the packing video, book the courier and mark it ready for pickup from the order page. A late dispatch can carry a penalty.`,
      ].join('\n\n'),
      ctaHref: link,
      ctaLabel: 'Open the order',
    }).catch((err) => console.error('[clowe-api] new-order email not queued:', err instanceof Error ? err.message : err));
  }
}
