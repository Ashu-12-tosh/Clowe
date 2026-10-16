// ---------------------------------------------------------------------------
// Delivery timelines as the Shipping Policy states them (clause 3):
//
//   processing: 1–2 working days from the order (the seller's dispatch);
//   after dispatch, by destination —
//     metro cities 2–4 working days, other cities and towns 4–7,
//     remote areas, North-East, J&K, Ladakh, Andaman & Nicobar and
//     Lakshadweep 7–12.
//
// Working days leave out Sundays (3.3). Public holidays are not known here,
// so an estimate can run a day short in a holiday week — it is an estimate.
//
// And the rest of the policy that needs a number: up to three delivery
// attempts (6.5), no post-office-box addresses (2.3), and a parcel 15 days
// past its estimated date and not traceable treated as lost (9.2).
// ---------------------------------------------------------------------------

export type DeliveryZone = 'METRO' | 'OTHER' | 'REMOTE';

export const DELIVERY_ZONE_META: Record<DeliveryZone, { label: string; transitDays: [number, number] }> = {
  METRO: { label: 'Metro city', transitDays: [2, 4] },
  OTHER: { label: 'Other cities and towns', transitDays: [4, 7] },
  REMOTE: { label: 'Remote area', transitDays: [7, 12] },
};

/** Order processing before dispatch (Shipping Policy 3.1). */
export const PROCESSING_WORKING_DAYS: [number, number] = [1, 2];

/** Delivery attempts the courier ordinarily makes (6.5). */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** Days past the estimated date before an untraceable parcel is lost (9.2). */
export const LOST_AFTER_ETA_DAYS = 15;

/**
 * No courier scan for this long counts as "not traceable" (9.2). A parcel
 * still being scanned is late, not lost.
 */
export const UNTRACEABLE_AFTER_DAYS = 7;

/**
 * Metro PIN code areas, by the first three digits: Delhi and the NCR
 * (Delhi 110, Faridabad 121, Gurugram 122, Ghaziabad and Noida 201), Mumbai
 * with Thane and Navi Mumbai (400–401), Kolkata (700), Chennai (600),
 * Bengaluru (560), Hyderabad (500), Pune (411) and Ahmedabad (380).
 */
const METRO_PREFIXES = new Set(['110', '121', '122', '201', '400', '401', '700', '600', '560', '500', '411', '380']);

/**
 * The policy's remote list, by PIN code: the North-East (Assam 78x,
 * Arunachal, Meghalaya, Manipur, Mizoram, Nagaland and Tripura 79x, Sikkim
 * 737), Jammu & Kashmir and Ladakh (18x, 19x), Andaman & Nicobar (744) and
 * Lakshadweep (68255x).
 */
export function deliveryZoneFor(pincode: string): DeliveryZone {
  const pin = pincode.trim();
  if (!/^\d{6}$/.test(pin)) return 'OTHER';
  const two = pin.slice(0, 2);
  const three = pin.slice(0, 3);
  if (two === '78' || two === '79' || three === '737') return 'REMOTE';
  if (two === '18' || two === '19') return 'REMOTE';
  if (three === '744' || pin.startsWith('68255')) return 'REMOTE';
  if (METRO_PREFIXES.has(three)) return 'METRO';
  return 'OTHER';
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Whether this moment falls on a Sunday in India. */
function isIstSunday(date: Date): boolean {
  return new Date(date.getTime() + IST_OFFSET_MS).getUTCDay() === 0;
}

/** `days` working days (Monday to Saturday, India time) after `from`. */
export function addWorkingDays(from: Date, days: number): Date {
  const date = new Date(from);
  let left = days;
  while (left > 0) {
    date.setTime(date.getTime() + 24 * 60 * 60 * 1000);
    if (!isIstSunday(date)) left -= 1;
  }
  return date;
}

/** The estimate shown before and at the order: processing plus the zone's transit. */
export function orderEtaWindow(pincode: string, now: Date = new Date()): { from: Date; to: Date; zone: DeliveryZone } {
  const zone = deliveryZoneFor(pincode);
  const [tMin, tMax] = DELIVERY_ZONE_META[zone].transitDays;
  const [pMin, pMax] = PROCESSING_WORKING_DAYS;
  return { from: addWorkingDays(now, pMin + tMin), to: addWorkingDays(now, pMax + tMax), zone };
}

/** The estimate once the parcel is dispatched: the zone's transit from then. */
export function dispatchedEtaWindow(pincode: string, dispatchedAt: Date): { from: Date; to: Date; zone: DeliveryZone } {
  const zone = deliveryZoneFor(pincode);
  const [tMin, tMax] = DELIVERY_ZONE_META[zone].transitDays;
  return { from: addWorkingDays(dispatchedAt, tMin), to: addWorkingDays(dispatchedAt, tMax), zone };
}

/**
 * A post-office-box address (Shipping Policy 2.3): "PO Box 12", "P.O. Box",
 * "Post Box No. 5", "POB 7", "GPO Box". A street or a post office's name
 * ("Near Post Office", "Gandhi Nagar P.O.") is an address, not a box.
 */
export function isPoBoxAddress(...lines: (string | null | undefined)[]): boolean {
  const text = lines.filter(Boolean).join(' ').toLowerCase();
  return /\b(?:g\.?\s*)?p\.?\s*o\.?\s*b(?:ox)?\b\.?\s*(?:no\.?\s*)?#?\s*\d/.test(text) ||
    /\bpost\s*(?:office\s*)?box\s*(?:no\.?\s*)?#?\s*\d/.test(text) ||
    /\bp\.?\s*o\.?\s*box\b/.test(text);
}

export const PO_BOX_MESSAGE = 'We can’t deliver to a post office box. Please give a street address.';

/** The buyer's choice for a parcel lost in transit (9.2). */
export const LOST_PARCEL_CHOICES = ['REPLACEMENT', 'REFUND'] as const;
export type LostParcelChoice = (typeof LOST_PARCEL_CHOICES)[number];
