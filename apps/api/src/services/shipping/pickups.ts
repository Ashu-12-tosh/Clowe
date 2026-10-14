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
// Delhivery takes one pickup request per pickup address and day, with the
// number of parcels; a parcel asked for on a day that already has a request
// joins it. Every parcel needs its order's packing video first: no clip, no
// dispatch. The line becomes Shipped when Delhivery's pickup scan says it was
// collected — except on the mock courier, which collects on the spot.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 330 * 60_000;
/** Delhivery collects in working hours: book the next 11:00 IST that isn't a Sunday. */
const PICKUP_HOUR_IST = 11;

export function nextPickupSlot(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const slot = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), PICKUP_HOUR_IST, 0, 0));
  // Today's slot if it is still at least two hours away; otherwise tomorrow's.
  if (slot.getTime() - ist.getTime() < 2 * 60 * 60_000) slot.setUTCDate(slot.getUTCDate() + 1);
  if (slot.getUTCDay() === 0) slot.setUTCDate(slot.getUTCDate() + 1);
  return new Date(slot.getTime() - IST_OFFSET_MS);
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
 * is joined, not repeated.
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
  const pickupAt = input.pickupAt ?? nextPickupSlot();

  // A request already made for this address and day: join it.
  const sameDay = await prisma.shipment.findFirst({
    where: { sellerId: input.sellerId, pickupRequestId: { not: null }, pickupScheduledFor: { not: null } },
    orderBy: { pickupRequestedAt: 'desc' },
    select: { pickupRequestId: true, pickupScheduledFor: true },
  });
  let pickupRequestId: string;
  let scheduledFor: Date;
  if (sameDay?.pickupScheduledFor && istDay(sameDay.pickupScheduledFor) === istDay(pickupAt)) {
    pickupRequestId = sameDay.pickupRequestId!;
    scheduledFor = sameDay.pickupScheduledFor;
  } else {
    try {
      const r = await shippingProvider.requestPickup({ warehouseName: sync.name, pickupAt, expectedPackages: shipments.length });
      pickupRequestId = r.pickupRequestId;
      scheduledFor = r.scheduledFor;
    } catch (err) {
      if (err instanceof ShippingProviderError) throw ApiError.badRequest(`Delhivery: ${err.message}`, err.code);
      throw err;
    }
  }

  const now = new Date();
  await prisma.shipment.updateMany({
    where: { id: { in: shipments.map((s) => s.id) }, status: 'CREATED' },
    data: { status: 'PICKUP_REQUESTED', pickupRequestId, pickupRequestedAt: now, pickupScheduledFor: scheduledFor },
  });

  // The mock courier collects on the spot: the parcels are on their way now.
  const collected = shippingProvider.name === 'mock';
  if (collected) {
    for (const s of shipments) for (const line of s.items) await markLineShipped(line.id, now);
  }
  return { pickupRequestId, scheduledFor, shipmentIds: shipments.map((s) => s.id), collected };
}
