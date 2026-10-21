import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { hasPackingVideo } from '../packingVideos';
import { shippingProvider } from './index';
import { markLineShipped } from './lineTransitions';
import { ShippingProviderError } from './ShippingProvider';
import { syncWarehouse } from './warehouses';

// ---------------------------------------------------------------------------
// Asking Delhivery to collect booked parcels from the seller's pickup address.
//
// Clowe's Delhivery account is on manual pickup: a booked parcel is only
// collected once a pickup request names it. The seller asks with "Ready for
// pickup" — which needs the order's packing video first: no clip, no
// dispatch. Delhivery takes one pickup request per pickup address and day,
// with the number of parcels; a parcel asked for on a day that already has a
// request joins it, and Delhivery is sent the new count. The line becomes
// Shipped when Delhivery's pickup scan says it was collected — except on the
// mock courier, which collects on the spot.
//
// When Delhivery did not collect ("Not Picked"), the parcel goes back to
// waiting, the seller and admins are told, and the seller asks again.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 330 * 60_000;
/** Asked before 14:00 IST, a pickup can still be today; after it, the next working day. */
export const PICKUP_CUTOFF_HOUR_IST = 14;
/**
 * Delhivery only promises tomorrow's pickup for requests made by 22:00 IST:
 * asked later, it is the pickup day after the next one.
 */
export const NEXT_DAY_CUTOFF_HOUR_IST = 22;
/** Delhivery needs time to send someone: a pickup today is never sooner than this. */
const SAME_DAY_LEAD_MINUTES = 120;

/** When a seller wants Delhivery to come: a time (IST, HH:MM) and weekdays (1 = Monday … 6 = Saturday). */
export interface PickupSchedule {
  slot: string;
  days: number[];
}

/** 11:00, Monday to Saturday: how pickups were booked before sellers could choose. */
export const DEFAULT_PICKUP_SCHEDULE: PickupSchedule = { slot: '11:00', days: [1, 2, 3, 4, 5, 6] };

function scheduleOrDefault(schedule: PickupSchedule): { minutes: number; days: number[] } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.slot);
  const [h, min] = m ? [Number(m[1]), Number(m[2])] : [11, 0];
  // Sunday is never a pickup day.
  const days = schedule.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 6);
  return { minutes: h * 60 + min, days: days.length > 0 ? days : DEFAULT_PICKUP_SCHEDULE.days };
}

/**
 * The pickup to ask Delhivery for, asked at `now`:
 * - before 14:00 IST on one of the seller's pickup days — today, at their slot,
 *   or two hours from now (on the half hour) if the slot is sooner than that;
 * - otherwise — after 14:00, on a day off, or when Delhivery already failed to
 *   come today (`notToday`) — the next pickup day at their slot;
 * - from 22:00, not tomorrow: the first pickup day after it (Monday 23:00 →
 *   Wednesday; Saturday 22:30 → Monday, as Sunday is off anyway).
 * Never a Sunday.
 */
export function nextPickupSlot(now: Date = new Date(), schedule: PickupSchedule = DEFAULT_PICKUP_SCHEDULE, opts: { notToday?: boolean } = {}): Date {
  const { minutes: slot, days } = scheduleOrDefault(schedule);
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  const at = (dayOffset: number, minutes: number) => new Date(midnight + dayOffset * 86_400_000 + minutes * 60_000 - IST_OFFSET_MS);

  const nowMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (!opts.notToday && days.includes(ist.getUTCDay()) && nowMinutes < PICKUP_CUTOFF_HOUR_IST * 60) {
    const earliest = Math.ceil((nowMinutes + SAME_DAY_LEAD_MINUTES) / 30) * 30;
    return at(0, Math.max(slot, earliest));
  }
  // From 22:00 tomorrow is too soon to ask for: the search starts the day
  // after. It skips calendar days, not pickup days — Saturday night used to
  // pass over Monday too and land on Tuesday (pre-launch audit 2026-10-20).
  const first = nowMinutes >= NEXT_DAY_CUTOFF_HOUR_IST * 60 ? 2 : 1;
  for (let offset = first; offset <= 14; offset += 1) {
    if (days.includes((ist.getUTCDay() + offset) % 7)) return at(offset, slot);
  }
  return at(first, slot);
}

const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

export interface PickupOutcome {
  pickupRequestId: string;
  scheduledFor: Date;
  /** Parcels newly in this request. */
  shipmentIds: string[];
  /** True on the mock courier: collected at once, so the lines are shipped. */
  collected: boolean;
}

/**
 * Request collection of the seller's booked parcels. Refuses parcels that are
 * not the seller's, not booked, already asked for, or without their packing
 * video. Delhivery is asked once per day: a request already made for the day
 * is joined — Delhivery is sent the new parcel count — not repeated.
 */
export async function requestPickup(input: { sellerId: string; shipmentIds: string[]; pickupAt?: Date }): Promise<PickupOutcome> {
  const shipments = await prisma.shipment.findMany({
    where: { id: { in: input.shipmentIds }, sellerId: input.sellerId, kind: 'FORWARD' },
    include: { items: { select: { id: true, status: true } } },
  });
  if (shipments.length !== new Set(input.shipmentIds).size) throw ApiError.notFound('Parcel not found');
  for (const s of shipments) {
    if (s.status !== 'CREATED' || !s.awbNumber) {
      throw ApiError.badRequest(`Parcel ${s.awbNumber ?? s.id} is not waiting for a pickup`, 'NOT_AWAITING_PICKUP');
    }
    if (!(await hasPackingVideo(s.orderId, input.sellerId))) {
      throw ApiError.badRequest('Record the packing video for every parcel before asking for a pickup', 'PACKING_VIDEO_REQUIRED');
    }
  }

  const sync = await syncWarehouse(input.sellerId);
  if (sync.status !== 'ACTIVE' || !sync.name) {
    throw ApiError.badRequest(`Your pickup address isn't registered with Delhivery yet — ${sync.error ?? 'try again shortly'}`, 'PICKUP_ADDRESS_NOT_READY');
  }
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: input.sellerId }, select: { pickupSlot: true, pickupDays: true } });
  const now = new Date();
  // Delhivery already failed to come today: not today again.
  const failedToday = shipments.some((s) => s.pickupFailedAt && istDay(s.pickupFailedAt) === istDay(now));
  const pickupAt = input.pickupAt ?? nextPickupSlot(now, { slot: seller.pickupSlot, days: seller.pickupDays }, { notToday: failedToday });

  // A request already made for this address and day: join it.
  const sameDay = await prisma.shipment.findFirst({
    where: { sellerId: input.sellerId, pickupRequestId: { not: null }, pickupScheduledFor: { not: null } },
    orderBy: { pickupRequestedAt: 'desc' },
    select: { pickupRequestId: true, pickupScheduledFor: true },
  });
  let pickupRequestId: string;
  let scheduledFor: Date;
  try {
    if (sameDay?.pickupScheduledFor && istDay(sameDay.pickupScheduledFor) === istDay(pickupAt)) {
      pickupRequestId = sameDay.pickupRequestId!;
      scheduledFor = sameDay.pickupScheduledFor;
      // Tell Delhivery how many parcels the request now has.
      const already = await prisma.shipment.count({ where: { sellerId: input.sellerId, pickupRequestId } });
      await shippingProvider.requestPickup({
        warehouseName: sync.name,
        pickupAt: scheduledFor,
        expectedPackages: already + shipments.length,
        existingRequestId: pickupRequestId,
      });
    } else {
      const r = await shippingProvider.requestPickup({ warehouseName: sync.name, pickupAt, expectedPackages: shipments.length });
      pickupRequestId = r.pickupRequestId;
      scheduledFor = r.scheduledFor;
    }
  } catch (err) {
    if (err instanceof ShippingProviderError) throw ApiError.badRequest(`Delhivery: ${err.message}`, err.code);
    throw err;
  }

  await prisma.shipment.updateMany({
    where: { id: { in: shipments.map((s) => s.id) }, status: 'CREATED' },
    data: { status: 'PICKUP_REQUESTED', pickupRequestId, pickupRequestedAt: now, pickupScheduledFor: scheduledFor, statusText: null },
  });

  // The mock courier collects on the spot: the parcels are on their way now.
  const collected = shippingProvider.name === 'mock';
  if (collected) {
    for (const s of shipments) for (const line of s.items) await markLineShipped(line.id, now);
  }
  return { pickupRequestId, scheduledFor, shipmentIds: shipments.map((s) => s.id), collected };
}

/**
 * Delhivery did not collect a parcel it was asked to ("Not Picked"): it waits
 * for a pickup again, the seller asks for another, and the seller and admins
 * hear about it. Once per request. A parcel whose lines were all cancelled is
 * left alone — that "Not Picked" is our own cancellation.
 */
export async function failPickup(shipmentId: string, at: Date, reason: string): Promise<boolean> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { items: { select: { status: true } }, order: { select: { orderNumber: true } }, seller: { select: { userId: true, shopName: true } } },
  });
  if (!shipment || shipment.status !== 'PICKUP_REQUESTED' || shipment.cancelledAt) return false;
  if (shipment.items.length > 0 && shipment.items.every((i) => i.status === 'CANCELLED')) return false;

  const { count } = await prisma.shipment.updateMany({
    where: { id: shipment.id, status: 'PICKUP_REQUESTED' },
    data: {
      status: 'CREATED',
      pickupRequestId: null,
      pickupRequestedAt: null,
      pickupScheduledFor: null,
      pickupFailedAt: at,
      pickupFailures: { increment: 1 },
      statusText: `Not collected: ${reason}`,
    },
  });
  if (count === 0) return false;

  const what = `AWB ${shipment.awbNumber ?? '—'} (order ${shipment.order.orderNumber})`;
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await prisma.notification.createMany({
    data: [
      {
        userId: shipment.seller.userId,
        type: 'SELLER_PICKUP_FAILED',
        title: `Delhivery didn't collect ${what}`,
        body: `Delhivery says: ${reason}. Keep the parcel packed with its label on, and press "Ready for pickup" on the order again — it goes to the next pickup day.`,
        linkHref: `/seller/orders/${shipment.orderId}`,
      },
      ...admins.map((a) => ({
        userId: a.id,
        type: 'PICKUP_FAILED',
        title: `Pickup failed: ${what}, ${shipment.seller.shopName}`,
        body: `Delhivery says: ${reason}. The seller has been asked to request a pickup again. If it keeps failing, raise it with Delhivery support.`,
        linkHref: '/admin/shipments',
      })),
    ],
  });
  return true;
}
