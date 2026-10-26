import {
  DELIVERY_NOT_AVAILABLE,
  deliveryPromise,
  promiseLabel,
  type DeliveryPromise,
  type SellerDeliveryPromiseView,
} from '@clowe/shared';
import { prisma } from '../../db';
import { cachedQuote, cachedTransit, slabOf, within } from './courierCache';
import { chargeableGrams } from './freight';
import { pincodeServiceability } from './serviceability';
import { pickupAddress, planParcel } from './shipments';

// ---------------------------------------------------------------------------
// The delivery date each seller's part of a cart or order is promised, from
// that seller's pickup pincode (deliveryPromise in @clowe/shared has the
// arithmetic). Delhivery is asked for its transit time and whether it
// delivers here, both cached for a day; if it is slow or down the zone range
// stands in and nothing is refused on its account — checkout never fails
// because Delhivery didn't answer.
// ---------------------------------------------------------------------------

/** How long a buyer-facing page waits for Delhivery before using the zone range. */
const WAIT_MS = 2_500;

const SELLER_SELECT = {
  id: true,
  shopName: true,
  dispatchDays: true,
  pickupSameAsBusiness: true,
  addressLine1: true,
  city: true,
  state: true,
  pincode: true,
  pickupLine1: true,
  pickupCity: true,
  pickupState: true,
  pickupPincode: true,
} as const;

type PromiseSeller = { id: string; shopName: string; dispatchDays: number } & Parameters<typeof pickupAddress>[0];

export interface SellerPromise extends DeliveryPromise {
  sellerId: string;
  shopName: string;
  originPincode: string | null;
  /** False: Delhivery doesn't deliver here. Null: it couldn't be asked (treated as deliverable). */
  deliverable: boolean | null;
  tatDays: number | null;
  dispatchDays: number;
}

/** One seller's promise to a delivery pincode. */
export async function promiseFor(seller: PromiseSeller, destinationPincode: string, now = new Date()): Promise<SellerPromise> {
  const origin = pickupAddress(seller).pincode;
  const [check, transit] = await Promise.all([
    within(pincodeServiceability(destinationPincode), WAIT_MS),
    origin ? within(cachedTransit(origin, destinationPincode), WAIT_MS) : Promise.resolve(null),
  ]);
  const refused = (check && !check.serviceable) || (transit && !transit.serviceable);
  const deliverable = refused ? false : check || transit ? true : null;
  const tatDays = transit?.serviceable ? transit.tatDays : null;
  const p = deliveryPromise({ now, dispatchDays: seller.dispatchDays, tatDays, destinationPincode });
  return { ...p, sellerId: seller.id, shopName: seller.shopName, originPincode: origin ?? null, deliverable, tatDays, dispatchDays: seller.dispatchDays };
}

/** Promises for several sellers at once, in the order given. */
export async function promisesFor(sellerIds: string[], destinationPincode: string, now = new Date()): Promise<SellerPromise[]> {
  const unique = [...new Set(sellerIds)];
  const sellers = await prisma.sellerProfile.findMany({ where: { id: { in: unique } }, select: SELLER_SELECT });
  const byId = new Map(sellers.map((s) => [s.id, s]));
  return Promise.all(unique.filter((id) => byId.has(id)).map((id) => promiseFor(byId.get(id)!, destinationPincode, now)));
}

/** As the buyer's pages show it. */
export function promiseView(p: SellerPromise): SellerDeliveryPromiseView {
  return {
    sellerId: p.sellerId,
    shopName: p.shopName,
    deliverable: p.deliverable,
    deliveryBy: p.deliverable === false ? null : p.deliveryBy.toISOString(),
    deliveryByLatest: p.deliverable === false || !p.deliveryByLatest ? null : p.deliveryByLatest.toISOString(),
    source: p.deliverable === false ? null : p.source,
    label: p.deliverable === false ? DELIVERY_NOT_AVAILABLE : promiseLabel(p),
    priceLabel: 'Free delivery',
  };
}

/**
 * Keep what a new order promised, per seller: the buyer's date and the
 * freight estimate the seller's order page shows "at placement". Called once
 * the order exists; Delhivery being down leaves the estimate empty, never the
 * order. Safe to call again: a seller's row is written once.
 */
export async function recordOrderPromises(orderId: string, promises: SellerPromise[]): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: { select: { weightGrams: true, lengthMm: true, widthMm: true, heightMm: true } } } } },
  });
  if (!order) return;
  for (const p of promises) {
    const lines = order.items.filter((i) => i.sellerId === p.sellerId);
    if (lines.length === 0) continue;
    const plan = planParcel(order, lines);
    const chargeable = chargeableGrams(plan);
    const quote = p.originPincode
      ? await within(
          cachedQuote({
            originPincode: p.originPincode,
            destinationPincode: order.shipPincode,
            mode: 'SURFACE',
            weightGrams: slabOf(chargeable),
            kind: 'DELIVERED',
            payment: 'PREPAID',
          }),
          5_000,
        )
      : null;
    await prisma.orderSellerPromise.upsert({
      where: { orderId_sellerId: { orderId, sellerId: p.sellerId } },
      update: {},
      create: {
        orderId,
        sellerId: p.sellerId,
        originPincode: p.originPincode,
        destinationPincode: order.shipPincode,
        deliveryBy: p.deliveryBy,
        deliveryByLatest: p.deliveryByLatest,
        source: p.source,
        tatDays: p.tatDays,
        dispatchDays: p.dispatchDays,
        freightEstimatePaise: quote?.totalPaise ?? null,
        freightZone: quote?.zone || null,
        chargeableGrams: chargeable,
      },
    });
  }
}

/** The order's window over all its sellers: the earliest promised day to the latest. */
export function orderWindow(promises: SellerPromise[]): { from: Date; to: Date } | null {
  if (promises.length === 0) return null;
  const from = new Date(Math.min(...promises.map((p) => p.deliveryBy.getTime())));
  const to = new Date(Math.max(...promises.map((p) => (p.deliveryByLatest ?? p.deliveryBy).getTime())));
  return { from, to };
}

/** Lines that can't reach this pincode: Delhivery says it doesn't deliver there from their seller. */
export function undeliverableMessage(pincode: string, titles: string[]): string | null {
  if (titles.length === 0) return null;
  const names = titles.map((t) => `"${t}"`).join(', ');
  return `${names} can't be delivered to ${pincode} — remove ${titles.length === 1 ? 'it' : 'them'} from this order or choose another address.`;
}
