import type { ShipmentStatus } from '@prisma/client';
import { prisma } from '../../db';
import { shippingProvider } from './index';
import { postForwardFreight, postRtoFreight } from './freight';
import { syncOrderStatus } from '../orderStatusService';
import { markLineDelivered, markLineShipped } from './lineTransitions';
import { notifyFailedAttempt, notifyRtoArrived, startRto } from './rto';
import { applyReverseScan } from './reversePickup';
import { syncShipmentsFromLines } from './shipments';
import { TRACK_BATCH, type TrackingResult } from './ShippingProvider';

// ---------------------------------------------------------------------------
// Delhivery's scans, applied. Whether a scan arrives by webhook, by the
// polling job or by an admin's "refresh", it goes through here:
//
// - every scan is stored once (shipment, time, status, code), however many
//   times it is pushed or polled;
// - the parcel only moves forward — a late or replayed scan never takes it
//   back — and its lines move with it: the first pickup scan ships them (at
//   the scan's time, which the dispatch promise is judged on), a delivery
//   scan delivers them (and earns the sale), RTO scans send them back;
// - a new charged weight re-prices delivered freight as its own adjustment.
// ---------------------------------------------------------------------------

/** How far along a parcel is: a scan may only move it to a later rank. */
const RANK: Record<ShipmentStatus, number> = {
  CREATED: 0,
  PICKUP_REQUESTED: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERY_FAILED: 3,
  DELIVERED: 5,
  RTO_IN_TRANSIT: 6,
  RTO_DELIVERED: 7,
  CANCELLED: 8,
  LOST: 8,
};
/** Nothing more will happen to these. */
const FINAL: ShipmentStatus[] = ['DELIVERED', 'RTO_DELIVERED', 'CANCELLED', 'LOST'];
/** Statuses the polling job keeps asking about. */
export const OPEN_STATUSES: ShipmentStatus[] = ['PICKUP_REQUESTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'RTO_IN_TRANSIT'];

export type TrackingSource = 'POLL' | 'WEBHOOK' | 'ADMIN';

export interface AppliedTracking {
  awbNumber: string;
  /** False when no parcel of ours carries this AWB. */
  known: boolean;
  newScans: number;
  status: ShipmentStatus | null;
}

/** What a parcel's status means for its lines, and the time it happened. */
function scanTime(result: TrackingResult, match: (statusType: string, status: string) => boolean): Date {
  const scan = result.scans.find((s) => match(s.statusType.toUpperCase(), s.status.toLowerCase()));
  return scan && !Number.isNaN(scan.at.getTime()) ? scan.at : new Date();
}

export async function applyTracking(result: TrackingResult, source: TrackingSource): Promise<AppliedTracking> {
  const shipment = await prisma.shipment.findUnique({ where: { awbNumber: result.awbNumber }, include: { items: true } });
  if (!shipment) return { awbNumber: result.awbNumber, known: false, newScans: 0, status: null };

  const scans = result.scans.filter((s) => !Number.isNaN(s.at.getTime()));
  const { count: newScans } = await prisma.shipmentEvent.createMany({
    data: scans.map((s) => ({
      shipmentId: shipment.id,
      at: s.at,
      status: s.status,
      statusType: s.statusType,
      code: s.code,
      location: s.location,
      instructions: s.instructions,
      source,
    })),
    skipDuplicates: true,
  });
  const lastScanAt = scans.reduce<Date | null>((max, s) => (!max || s.at > max ? s.at : max), shipment.lastScanAt);
  const weightChanged = result.chargedWeightGrams !== null && result.chargedWeightGrams !== shipment.chargedWeightGrams;

  // Only forward: a scan never undoes a later one — except on the road, where
  // a parcel goes out for delivery, fails an attempt and travels on again.
  const next = result.status;
  const onTheRoad = (s: ShipmentStatus) => s === 'IN_TRANSIT' || s === 'OUT_FOR_DELIVERY' || s === 'DELIVERY_FAILED';
  const moves =
    !FINAL.includes(shipment.status) &&
    (RANK[next] > RANK[shipment.status] || (onTheRoad(next) && onTheRoad(shipment.status) && next !== shipment.status));
  await prisma.shipment.update({
    where: { id: shipment.id },
    data: {
      statusText: result.statusText || shipment.statusText,
      lastScanAt,
      ...(weightChanged ? { chargedWeightGrams: result.chargedWeightGrams } : {}),
      ...(moves && next !== 'DELIVERED' && next !== 'RTO_DELIVERED' ? { status: next } : {}),
      ...(moves && next === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
    },
  });

  // A return coming back: its scans move the return, never the order's lines.
  if (shipment.kind === 'REVERSE') {
    if (moves && (next === 'IN_TRANSIT' || next === 'DELIVERED')) {
      const at = scanTime(result, (t) => (next === 'DELIVERED' ? t === 'DL' : t === 'PU'));
      await applyReverseScan(shipment, next, at);
      await prisma.shipment.update({
        where: { id: shipment.id },
        data:
          next === 'DELIVERED'
            ? { status: 'DELIVERED', deliveredAt: at, pickedUpAt: shipment.pickedUpAt ?? at }
            : { pickedUpAt: shipment.pickedUpAt ?? at },
      });
    }
    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true } });
    return { awbNumber: result.awbNumber, known: true, newScans, status: after.status };
  }

  if (moves) {
    const live = shipment.items.filter((i) => i.status !== 'CANCELLED');
    const pickedUpAt = scanTime(result, (t, s) => t === 'UD' && s === 'in transit');
    // Any scan past pickup means it was collected: the lines are shipped.
    if (RANK[next] >= RANK.IN_TRANSIT && next !== 'CANCELLED') {
      for (const line of live) await markLineShipped(line.id, pickedUpAt);
      if (!shipment.pickedUpAt) await prisma.shipment.update({ where: { id: shipment.id }, data: { pickedUpAt } });
    }
    if (next === 'DELIVERED') {
      const at = scanTime(result, (t) => t === 'DL');
      for (const line of live) await markLineDelivered(line.id, at);
      await prisma.shipment.update({ where: { id: shipment.id }, data: { deliveredAt: at } });
    }
    if (next === 'DELIVERY_FAILED') {
      await notifyFailedAttempt(shipment, result.statusText || 'Delivery attempt failed');
    }
    if ((next === 'RTO_IN_TRANSIT' || next === 'RTO_DELIVERED') && live.length === 0) {
      // Every line was cancelled after pickup (an admin's cancellation): the
      // buyer was refunded and the stock put back then, so there is nothing to
      // count or refund — but the parcel still travelled, and comes back.
      if (next === 'RTO_DELIVERED') {
        const at = scanTime(result, (t, s) => t === 'DL' && s === 'rto');
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: { status: 'RTO_DELIVERED', rtoDeliveredAt: at, rtoInitiatedAt: shipment.rtoInitiatedAt ?? at },
        });
        await postRtoFreight(shipment.id).catch((err) =>
          console.error('[clowe-api] RTO freight not posted yet for', shipment.awbNumber, err instanceof Error ? err.message : err),
        );
        await notifyRtoArrived(shipment);
      }
    } else if (next === 'RTO_IN_TRANSIT' || next === 'RTO_DELIVERED') {
      // The first sign it is coming back: count it, refund a prepaid buyer, tell both.
      if (!shipment.rtoInitiatedAt) await startRto(shipment, scanTime(result, (t) => t === 'RT'));
      await prisma.orderItem.updateMany({
        where: { shipmentId: shipment.id, status: { in: ['SHIPPED', 'RTO_IN_TRANSIT'] } },
        data: { status: next === 'RTO_DELIVERED' ? 'RTO_DELIVERED' : 'RTO_IN_TRANSIT' },
      });
      await syncShipmentsFromLines([shipment.id]);
      await syncOrderStatus(shipment.orderId);
      if (next === 'RTO_DELIVERED') await notifyRtoArrived(shipment);
    }
    if (next === 'LOST') {
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
      await prisma.notification.createMany({
        data: admins.map((a) => ({
          userId: a.id,
          type: 'SHIPMENT_LOST',
          title: `Parcel lost in transit — AWB ${shipment.awbNumber}`,
          body: 'Delhivery reports this parcel lost. Refund the buyer, then claim it from Delhivery.',
          linkHref: '/admin/orders',
        })),
      });
    }
  }

  // Delhivery re-weighed a delivered parcel: re-price its freight.
  if (weightChanged && (shipment.status === 'DELIVERED' || next === 'DELIVERED')) {
    await postForwardFreight(shipment.id).catch((err) =>
      console.error('[clowe-api] freight re-pricing failed for', shipment.awbNumber, err instanceof Error ? err.message : err),
    );
  }

  const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true } });
  return { awbNumber: result.awbNumber, known: true, newScans, status: after.status };
}

/** Ask the courier about these parcels (30 at a time) and apply what it says. */
export async function refreshShipments(awbNumbers: string[], source: TrackingSource): Promise<AppliedTracking[]> {
  const out: AppliedTracking[] = [];
  for (let i = 0; i < awbNumbers.length; i += TRACK_BATCH) {
    const results = await shippingProvider.track(awbNumbers.slice(i, i + TRACK_BATCH));
    for (const r of results) out.push(await applyTracking(r, source));
  }
  return out;
}

/** Every parcel still moving, booked with the courier now in use. */
export async function pollOpenShipments(): Promise<number> {
  const open = await prisma.shipment.findMany({
    where: { status: { in: OPEN_STATUSES }, awbNumber: { not: null }, provider: shippingProvider.name },
    select: { awbNumber: true },
    orderBy: { lastScanAt: { sort: 'asc', nulls: 'first' } },
    take: 3_000,
  });
  const applied = await refreshShipments(open.map((s) => s.awbNumber!), 'POLL');
  return applied.reduce((sum, a) => sum + a.newScans, 0);
}

/** Every 30 minutes (Delhivery allows 750 calls per 5 minutes; this uses a handful). */
export function startTrackingPoll(): void {
  const run = () => {
    pollOpenShipments()
      .then((n) => {
        if (n > 0) console.log(`[clowe-api] courier scans recorded: ${n}`);
      })
      .catch((err) => console.error('[clowe-api] tracking poll failed:', err instanceof Error ? err.message : err));
  };
  const timer = setInterval(run, 30 * 60 * 1000);
  timer.unref();
}
