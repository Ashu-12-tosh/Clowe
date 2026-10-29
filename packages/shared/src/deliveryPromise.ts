import { DELIVERY_ZONE_META, deliveryZoneFor } from './deliveryZone';

// ---------------------------------------------------------------------------
// The delivery date a buyer is promised, one per seller (owner, 29 Oct):
//
//   processing  starts today in India, or the next working day when the
//               order comes after the cut-off (14:00 IST) or on a Sunday;
//   dispatch    the same day: the 18-hour dispatch promise;
//   pickup      the next working day (pickups are requested, not standing);
//   transit     Delhivery's TAT from the seller's pickup pincode, in working days;
//   buffer      one more working day.
//
// Working days leave out Sundays only. When Delhivery can't be asked (slow, down)
// the Shipping Policy's zone range stands in for its TAT, and the buyer sees
// a range instead of one day. Every date here is a day in India, carried as
// midnight IST.
// ---------------------------------------------------------------------------

/** Orders after this hour (IST) count from the next working day. */
export const DELIVERY_CUTOFF_HOUR_IST = 14;
/** The day added on top of dispatch and transit. */
export const DELIVERY_BUFFER_DAYS = 1;

const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight IST of the India-time day `at` falls on. */
export function istMidnightOf(at: Date): Date {
  const ist = at.getTime() + IST_MS;
  return new Date(ist - (((ist % DAY_MS) + DAY_MS) % DAY_MS) - IST_MS);
}

function istWeekday(day: Date): number {
  return new Date(day.getTime() + IST_MS).getUTCDay();
}

/** `n` working days (Monday–Saturday) after the IST day `day`. */
export function addIstWorkingDays(day: Date, n: number): Date {
  let at = istMidnightOf(day);
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    at = new Date(at.getTime() + DAY_MS);
    if (istWeekday(at) !== 0) left -= 1;
  }
  return at;
}

/** The day processing starts (and the parcel is dispatched): today before the cut-off, else the next working day. */
export function promiseStartDay(now: Date): Date {
  const today = istMidnightOf(now);
  const hour = Math.floor((now.getTime() - today.getTime()) / (60 * 60 * 1000));
  if (istWeekday(today) === 0 || hour >= DELIVERY_CUTOFF_HOUR_IST) return addIstWorkingDays(today, 1);
  return today;
}

/** Working days from dispatch to Delhivery's pickup. */
export const PICKUP_AFTER_DISPATCH_DAYS = 1;

export interface DeliveryPromiseInput {
  now: Date;
  /** Delhivery's transit days from the seller's pickup pincode; null to use the zone range. */
  tatDays: number | null;
  /** The delivery pincode, for the zone range when there is no TAT. */
  destinationPincode: string;
}

export interface DeliveryPromise {
  /** The promised day (midnight IST). With a zone range, its first day. */
  deliveryBy: Date;
  /** The zone range's last day; null when Delhivery's TAT gave one day. */
  deliveryByLatest: Date | null;
  source: 'DELHIVERY_TAT' | 'ZONE';
  /** The day processing starts and the parcel is dispatched. */
  dispatchDay: Date;
  /** The day Delhivery collects it. */
  pickupDay: Date;
}

export function deliveryPromise(input: DeliveryPromiseInput): DeliveryPromise {
  const dispatchDay = promiseStartDay(input.now);
  const pickupDay = addIstWorkingDays(dispatchDay, PICKUP_AFTER_DISPATCH_DAYS);
  if (input.tatDays !== null && input.tatDays >= 0) {
    return {
      deliveryBy: addIstWorkingDays(pickupDay, input.tatDays + DELIVERY_BUFFER_DAYS),
      deliveryByLatest: null,
      source: 'DELHIVERY_TAT',
      dispatchDay,
      pickupDay,
    };
  }
  const [min, max] = DELIVERY_ZONE_META[deliveryZoneFor(input.destinationPincode)].transitDays;
  return {
    deliveryBy: addIstWorkingDays(pickupDay, min + DELIVERY_BUFFER_DAYS),
    deliveryByLatest: addIstWorkingDays(pickupDay, max + DELIVERY_BUFFER_DAYS),
    source: 'ZONE',
    dispatchDay,
    pickupDay,
  };
}

/** "Thu, 29 Oct" — how a promised day reads everywhere. */
export function promiseDayLabel(day: Date | string): string {
  return new Date(day).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/** "Delivery by Thu, 29 Oct", or "Delivery by Fri, 30 Oct – Tue, 3 Nov" on the zone range. */
export function promiseLabel(p: { deliveryBy: Date | string; deliveryByLatest: Date | string | null }): string {
  if (!p.deliveryByLatest || promiseDayLabel(p.deliveryByLatest) === promiseDayLabel(p.deliveryBy)) {
    return `Delivery by ${promiseDayLabel(p.deliveryBy)}`;
  }
  return `Delivery by ${promiseDayLabel(p.deliveryBy)} – ${promiseDayLabel(p.deliveryByLatest)}`;
}

/** One seller's part of a cart or order, as the buyer sees its delivery. */
export interface SellerDeliveryPromiseView {
  sellerId: string;
  shopName: string;
  /** False when Delhivery doesn't deliver this seller's parcel here; null when it couldn't be asked. */
  deliverable: boolean | null;
  deliveryBy: string | null;
  deliveryByLatest: string | null;
  source: 'DELHIVERY_TAT' | 'ZONE' | null;
  /** "Delivery by Thu, 29 Oct" or the reason it can't come. */
  label: string;
  /** Always "Free delivery": buyers never pay for delivery. */
  priceLabel: 'Free delivery';
}

/** GET /api/delivery/promise — the product page's PIN check. */
export interface ProductDeliveryPromise {
  pincode: string;
  deliverable: boolean;
  /** "Delivery by Thu, 29 Oct · Free delivery", or "Delivery not available at this PIN". */
  message: string;
  deliveryBy: string | null;
  deliveryByLatest: string | null;
  source: 'DELHIVERY_TAT' | 'ZONE' | null;
}

export const DELIVERY_NOT_AVAILABLE = 'Delivery not available at this PIN';

/** GET /api/cart/delivery-promises — the cart's and checkout's dates, per seller, for one PIN. */
export interface CartDeliveryPromises {
  pincode: string;
  sellers: SellerDeliveryPromiseView[];
  /** Which seller each cart line ships from. */
  lines: { variantId: string; sellerId: string }[];
  /** Set when some ticked lines can't reach this PIN: checkout refuses them by name. */
  blockedMessage: string | null;
}
