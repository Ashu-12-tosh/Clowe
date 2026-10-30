import {
  buildParcelTracking,
  buildReturnTracking,
  summarizeOrderTracking,
  TRACK_REFRESH_MINUTES,
  type OrderTrackingSummary,
  type ParcelTracking,
  type TrackRefundInput,
} from '@clowe/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { shippingProvider } from './index';
import { OPEN_STATUSES, refreshShipments } from './tracking';

// ---------------------------------------------------------------------------
// An order's tracking, parcel by parcel, as every page shows it: the buyer's
// order page and list, Track Order, and the seller's and admin's order pages
// (read-only there). A multi-seller order has one bar per parcel; lines not
// booked with the courier yet are grouped by seller.
//
// "Refresh" asks Delhivery about a parcel at most once per TRACK_REFRESH_MINUTES
// per AWB, whoever presses it — otherwise the stored scans are the answer.
// Never shown here: the seller's address or phone, or any buyer contact.
// ---------------------------------------------------------------------------

const EVENT_SELECT = { at: true, status: true, statusType: true, code: true, location: true, instructions: true } as const;

const SHIPMENT_SELECT = {
  id: true,
  kind: true,
  provider: true,
  status: true,
  awbNumber: true,
  createdAt: true,
  pickupFailedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  rtoInitiatedAt: true,
  rtoDeliveredAt: true,
  cancelledAt: true,
  deliveryAttempts: true,
  courierPromisedAt: true,
  etaTo: true,
  lostFlaggedAt: true,
  lostChoice: true,
  rtoReason: true,
  statusText: true,
  lastScanAt: true,
  trackedAt: true,
  events: { orderBy: { at: 'desc' as const }, take: 100, select: EVENT_SELECT },
} satisfies Prisma.ShipmentSelect;

const ORDER_INCLUDE = {
  payment: { select: { status: true } },
  refunds: { select: { returnId: true, reason: true, status: true, amountPaise: true, processedAt: true, createdAt: true }, orderBy: { createdAt: 'desc' as const } },
  sellerPromises: { select: { sellerId: true, deliveryBy: true, deliveryByLatest: true } },
  items: {
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      sellerId: true,
      title: true,
      quantity: true,
      status: true,
      packedAt: true,
      shippedAt: true,
      deliveredAt: true,
      cancelReason: true,
      cancelledBy: true,
      cancelledAt: true,
      courierName: true,
      awbNumber: true,
      seller: { select: { shopName: true } },
      shipment: { select: SHIPMENT_SELECT },
      return: {
        select: {
          id: true,
          rmaNumber: true,
          status: true,
          createdAt: true,
          approvedAt: true,
          rejectedAt: true,
          rejectionReason: true,
          pickedUpAt: true,
          receivedAt: true,
          resolution: true,
          remedy: true,
          selfShip: true,
          replacementOrderId: true,
          refund: { select: { status: true, amountPaise: true, processedAt: true } },
          reverseShipment: { select: { status: true, createdAt: true, pickedUpAt: true, deliveredAt: true, pickupFailedAt: true, events: { orderBy: { at: 'desc' as const }, take: 50, select: EVENT_SELECT } } },
        },
      },
    },
  },
} satisfies Prisma.OrderInclude;

type OrderForTracking = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;
type Line = OrderForTracking['items'][number];

const toRefund = (r: { status: string; amountPaise: number; processedAt: Date | null } | null | undefined): TrackRefundInput | null =>
  r ? { status: r.status, amountPaise: r.amountPaise, processedAt: r.processedAt } : null;

/** The refund belonging to this parcel: refunds name the AWB (RTO) or the reason (lost, cancelled). */
function parcelRefund(order: OrderForTracking, awb: string | null, kind: 'RTO' | 'LOST' | 'CANCELLED'): TrackRefundInput | null {
  const outside = order.refunds.filter((r) => !r.returnId);
  if (kind === 'RTO') return toRefund(outside.find((r) => awb && r.reason?.includes(awb)));
  if (kind === 'LOST') return toRefund(outside.find((r) => /lost/i.test(r.reason ?? '')));
  return toRefund(outside.find((r) => !/lost|AWB/i.test(r.reason ?? '')));
}

async function exchangeShippedAt(orderIds: string[]): Promise<Map<string, Date>> {
  if (orderIds.length === 0) return new Map();
  const lines = await prisma.orderItem.findMany({ where: { orderId: { in: orderIds }, shippedAt: { not: null } }, select: { orderId: true, shippedAt: true } });
  const out = new Map<string, Date>();
  for (const l of lines) if (!out.has(l.orderId) || l.shippedAt! < out.get(l.orderId)!) out.set(l.orderId, l.shippedAt!);
  return out;
}

async function buildTracking(order: OrderForTracking, now: Date): Promise<ParcelTracking[]> {
  const groups = new Map<string, Line[]>();
  for (const line of order.items) {
    const key = line.shipment && line.shipment.kind === 'FORWARD' ? line.shipment.id : `${line.sellerId}:${line.status === 'CANCELLED' ? 'cancelled' : 'open'}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const promiseBySeller = new Map(order.sellerPromises.map((p) => [p.sellerId, p]));
  const exchanges = await exchangeShippedAt(order.items.flatMap((i) => (i.return?.replacementOrderId ? [i.return.replacementOrderId] : [])));
  const awaitingPayment = order.payment?.status === 'CREATED' && order.status === 'PLACED' && order.paymentMethod !== 'COD';

  const parcels: ParcelTracking[] = [];
  for (const [key, lines] of groups) {
    const first = lines[0]!;
    const shipment = first.shipment?.kind === 'FORWARD' ? first.shipment : null;
    const awb = shipment?.awbNumber ?? first.awbNumber ?? null;
    const allCancelled = lines.every((l) => l.status === 'CANCELLED');
    const rto = shipment && (shipment.status.startsWith('RTO_') || lines.some((l) => l.status.startsWith('RTO_')));
    const lost = shipment && (shipment.lostFlaggedAt || shipment.status === 'LOST');
    const refund = allCancelled ? parcelRefund(order, awb, 'CANCELLED') : rto ? parcelRefund(order, awb, 'RTO') : lost ? parcelRefund(order, awb, 'LOST') : null;
    const promise = promiseBySeller.get(first.sellerId);
    const core = buildParcelTracking({
      now,
      placedAt: order.createdAt,
      paymentMethod: order.paymentMethod,
      awaitingPayment,
      lines,
      shipment,
      scans: shipment?.events ?? [],
      promise: promise ? { deliveryBy: promise.deliveryBy, deliveryByLatest: promise.deliveryByLatest } : null,
      orderEtaTo: order.etaTo,
      refund,
    });
    const open = !!shipment?.awbNumber && OPEN_STATUSES.includes(shipment.status) && shipment.provider === shippingProvider.name;
    parcels.push({
      ...core,
      key,
      shipmentId: shipment?.id ?? null,
      shopName: first.seller.shopName,
      items: lines.map((l) => ({ id: l.id, title: l.title, quantity: l.quantity })),
      courierName: awb ? (first.courierName ?? shippingProvider.courierName) : null,
      awbNumber: awb,
      lastUpdatedAt: (shipment?.trackedAt ?? shipment?.lastScanAt)?.toISOString() ?? null,
      canRefresh: open,
      returns: lines.flatMap((l) =>
        l.return
          ? [
              buildReturnTracking({
                returnId: l.return.id,
                itemTitle: l.title,
                rmaNumber: l.return.rmaNumber,
                now,
                status: l.return.status,
                createdAt: l.return.createdAt,
                approvedAt: l.return.approvedAt,
                rejectedAt: l.return.rejectedAt,
                rejectionReason: l.return.rejectionReason,
                pickedUpAt: l.return.pickedUpAt,
                receivedAt: l.return.receivedAt,
                resolution: l.return.resolution,
                remedy: l.return.remedy,
                selfShip: l.return.selfShip,
                pickup: l.return.reverseShipment,
                pickupScans: l.return.reverseShipment?.events ?? [],
                refund: toRefund(l.return.refund),
                exchangeShippedAt: l.return.replacementOrderId ? (exchanges.get(l.return.replacementOrderId) ?? null) : null,
                paymentMethod: order.paymentMethod,
              }),
            ]
          : [],
      ),
    });
  }
  return parcels;
}

/** Every parcel of an order — or only one seller's, for that seller's page. */
export async function orderTracking(orderId: string, opts: { sellerId?: string; now?: Date } = {}): Promise<ParcelTracking[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: opts.sellerId ? { ...ORDER_INCLUDE, items: { ...ORDER_INCLUDE.items, where: { sellerId: opts.sellerId } } } : ORDER_INCLUDE,
  });
  if (!order) return [];
  return buildTracking(order, opts.now ?? new Date());
}

/** The order list's chip and headline, for a page of orders. */
export async function ordersTrackingSummary(orderIds: string[], now = new Date()): Promise<Map<string, OrderTrackingSummary>> {
  const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, include: ORDER_INCLUDE });
  const out = new Map<string, OrderTrackingSummary>();
  for (const order of orders) {
    const summary = summarizeOrderTracking(await buildTracking(order, now));
    if (summary) out.set(order.id, summary);
  }
  return out;
}

export interface TrackingRefresh {
  /** Parcels Delhivery was asked about now. */
  asked: number;
  /** Parcels asked about in the last TRACK_REFRESH_MINUTES: their stored scans stand. */
  cached: number;
  /** The earliest a further refresh can ask again (ISO), when one was cached. */
  nextRefreshAt: string | null;
}

/**
 * The buyer's "Refresh": ask the courier about the order's moving parcels,
 * each at most once per TRACK_REFRESH_MINUTES. The claim on a parcel is taken
 * in the database first, so two presses at once still make one call.
 */
export async function refreshOrderTracking(orderId: string, now = new Date()): Promise<TrackingRefresh> {
  const cutoff = new Date(now.getTime() - TRACK_REFRESH_MINUTES * 60_000);
  const open = await prisma.shipment.findMany({
    where: { orderId, kind: 'FORWARD', awbNumber: { not: null }, status: { in: OPEN_STATUSES }, provider: shippingProvider.name },
    select: { id: true, awbNumber: true, trackedAt: true },
  });
  const claimed: string[] = [];
  let cached = 0;
  let next: Date | null = null;
  for (const s of open) {
    const { count } = await prisma.shipment.updateMany({
      where: { id: s.id, OR: [{ trackedAt: null }, { trackedAt: { lt: cutoff } }] },
      data: { trackedAt: now },
    });
    if (count === 1) claimed.push(s.awbNumber!);
    else {
      cached += 1;
      const again = new Date((s.trackedAt ?? now).getTime() + TRACK_REFRESH_MINUTES * 60_000);
      if (!next || again < next) next = again;
    }
  }
  if (claimed.length > 0) {
    try {
      await refreshShipments(claimed, 'POLL');
    } catch (err) {
      // The courier did not answer: the stored scans stand, and the claim
      // still holds, so a burst of presses doesn't become a burst of calls.
      console.error('[clowe-api] tracking refresh failed:', err instanceof Error ? err.message : err);
    }
  }
  return { asked: claimed.length, cached, nextRefreshAt: next?.toISOString() ?? null };
}
