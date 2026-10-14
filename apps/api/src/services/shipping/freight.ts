import { billedWeightGrams, volumetricWeightGrams } from '@clowe/shared';
import { prisma } from '../../db';
import { postEntry } from '../sellerLedgerService';
import { shippingProvider } from './index';
import { pickupAddress } from './shipments';
import type { ShippingMode } from './ShippingProvider';

// ---------------------------------------------------------------------------
// What the courier charges, and the seller pays.
//
// Buyers never pay for delivery. The seller pays Delhivery's actual forward
// freight for each parcel: estimated from the charges API when it is booked
// (and shown before they confirm), and posted to their ledger when it is
// delivered, at the weight Delhivery charged — the greater of actual and
// volumetric, in 0.5 kg slabs. A later change to the charged weight posts a
// separate adjustment, never an edit of the first entry.
//
// Amounts include GST: they are what Clowe pays Delhivery for the parcel.
// ---------------------------------------------------------------------------

export interface ParcelRoute {
  originPincode: string;
  destinationPincode: string;
  mode: ShippingMode;
  /** Chargeable weight: the greater of actual and volumetric. */
  weightGrams: number;
}

/** Chargeable weight of a box: the greater of its weight and its volumetric weight. */
export function chargeableGrams(p: {
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}): number {
  return billedWeightGrams(p.weightGrams, volumetricWeightGrams(p.lengthMm, p.widthMm, p.heightMm)) ?? p.weightGrams;
}

/** Forward freight for a parcel delivered, GST included, from the charges API. */
export async function forwardFreightPaise(route: ParcelRoute): Promise<number> {
  const q = await shippingProvider.quote({ ...route, kind: 'DELIVERED', payment: 'PREPAID' });
  return q.totalPaise;
}

/**
 * Delhivery's COD charge for collecting `codAmountPaise`, GST included: what a
 * COD quote costs over the same parcel prepaid. Read from the charges API —
 * ₹40 or 2 % today, whichever is higher — never worked out here.
 */
export async function codFeePaise(route: ParcelRoute, codAmountPaise: number): Promise<number> {
  if (codAmountPaise <= 0) return 0;
  const [prepaid, cod] = await Promise.all([
    shippingProvider.quote({ ...route, kind: 'DELIVERED', payment: 'PREPAID' }),
    shippingProvider.quote({ ...route, kind: 'DELIVERED', payment: 'COD', codAmountPaise }),
  ]);
  return Math.max(0, cod.totalPaise - prepaid.totalPaise);
}

const forwardKey = (shipmentId: string) => `forward-freight:${shipmentId}`;
const codFeeKey = (shipmentId: string) => `cod-fee:${shipmentId}`;
/** Each re-pricing is its own entry: the nth adjustment of a parcel. */
const adjustmentKey = (shipmentId: string, n: number) => `freight-adjustment:${shipmentId}:${n}`;

/** The parcel's route for the charges API, or null when the seller has no pickup pincode. */
async function routeOf(shipmentId: string) {
  const s = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { select: { orderNumber: true, shipPincode: true } }, seller: true },
  });
  if (!s) return null;
  const origin = pickupAddress(s.seller).pincode;
  if (!origin) return { shipment: s, route: null };
  const route: ParcelRoute = {
    originPincode: origin,
    destinationPincode: s.order.shipPincode,
    mode: s.mode === 'EXPRESS' ? 'EXPRESS' : 'SURFACE',
    // Delhivery's measured weight once it has one; ours until then.
    weightGrams: s.chargedWeightGrams ?? chargeableGrams(s),
  };
  return { shipment: s, route };
}

export type FreightOutcome = 'POSTED' | 'ADJUSTED' | 'UNCHANGED' | 'NOT_DELIVERED' | 'NO_ROUTE';

/**
 * Charge the seller the parcel's forward freight once it is delivered, and
 * adjust it if the charged weight later changes. Safe to call any number of
 * times: the entry and each adjustment are keyed, so a replay posts nothing.
 */
export async function postForwardFreight(shipmentId: string): Promise<FreightOutcome> {
  const found = await routeOf(shipmentId);
  if (!found) return 'NOT_DELIVERED';
  const { shipment: s, route } = found;
  if (s.kind !== 'FORWARD' || s.status !== 'DELIVERED') return 'NOT_DELIVERED';
  if (!route) return 'NO_ROUTE';

  const amount = await forwardFreightPaise(route);
  if (s.finalFreightPaise === null) {
    const posted = await postEntry({
      sellerId: s.sellerId,
      type: 'FORWARD_FREIGHT',
      bucket: 'SETTLEMENT',
      amountPaise: -amount,
      orderId: s.orderId,
      idempotencyKey: forwardKey(s.id),
      note: `Delhivery forward freight, ${s.order.orderNumber} (AWB ${s.awbNumber ?? '—'}, ${route.weightGrams / 1000} kg charged)`,
    });
    await prisma.shipment.update({
      where: { id: s.id },
      data: { finalFreightPaise: amount, freightWeightGrams: route.weightGrams },
    });
    return posted ? 'POSTED' : 'UNCHANGED';
  }

  // Already charged: only a different charged weight moves it.
  if (s.freightWeightGrams === route.weightGrams) return 'UNCHANGED';
  if (amount === s.finalFreightPaise) {
    // Same slab, same price: nothing to post, but remember the weight.
    await prisma.shipment.update({ where: { id: s.id }, data: { freightWeightGrams: route.weightGrams } });
    return 'UNCHANGED';
  }
  const earlier = await prisma.sellerLedgerEntry.count({
    where: { idempotencyKey: { startsWith: `freight-adjustment:${s.id}:` } },
  });
  const posted = await postEntry({
    sellerId: s.sellerId,
    type: 'FREIGHT_ADJUSTMENT',
    bucket: 'SETTLEMENT',
    amountPaise: -(amount - s.finalFreightPaise),
    orderId: s.orderId,
    idempotencyKey: adjustmentKey(s.id, earlier + 1),
    note: `Delhivery freight adjusted, ${s.order.orderNumber}: charged weight ${(s.freightWeightGrams ?? 0) / 1000} → ${route.weightGrams / 1000} kg`,
  });
  await prisma.shipment.update({
    where: { id: s.id },
    data: { finalFreightPaise: amount, freightWeightGrams: route.weightGrams },
  });
  return posted ? 'ADJUSTED' : 'UNCHANGED';
}

/**
 * Charge the seller Delhivery's COD fee once a COD parcel is delivered (the
 * cash was collected). Prepaid parcels owe none. Once, however often called.
 */
export async function postCodFee(shipmentId: string): Promise<FreightOutcome> {
  const found = await routeOf(shipmentId);
  if (!found) return 'NOT_DELIVERED';
  const { shipment: s, route } = found;
  if (s.kind !== 'FORWARD' || s.status !== 'DELIVERED') return 'NOT_DELIVERED';
  if (s.paymentType !== 'COD' || s.codAmountPaise <= 0 || s.codFeePaise !== null) return 'UNCHANGED';
  if (!route) return 'NO_ROUTE';
  const fee = await codFeePaise(route, s.codAmountPaise);
  const posted = await postEntry({
    sellerId: s.sellerId,
    type: 'COD_FEE',
    bucket: 'SETTLEMENT',
    amountPaise: -fee,
    orderId: s.orderId,
    idempotencyKey: codFeeKey(s.id),
    note: `Delhivery COD fee, ${s.order.orderNumber}: ₹${(s.codAmountPaise / 100).toFixed(2)} collected`,
  });
  await prisma.shipment.update({ where: { id: s.id }, data: { codFeePaise: fee } });
  return posted ? 'POSTED' : 'UNCHANGED';
}

/**
 * Delivered parcels whose freight is not on the ledger yet — the charges API
 * was down when they were delivered. Posted before any payout is worked out,
 * so money never leaves before the freight it owes.
 */
export async function ensureFreightPosted(sellerId: string): Promise<number> {
  const pending = await prisma.shipment.findMany({
    where: {
      sellerId,
      kind: 'FORWARD',
      status: 'DELIVERED',
      OR: [{ finalFreightPaise: null }, { paymentType: 'COD', codAmountPaise: { gt: 0 }, codFeePaise: null }],
    },
    select: { id: true },
    take: 200,
  });
  let posted = 0;
  for (const s of pending) {
    try {
      if ((await postForwardFreight(s.id)) === 'POSTED') posted += 1;
      if ((await postCodFee(s.id)) === 'POSTED') posted += 1;
    } catch (err) {
      console.error('[clowe-api] freight not posted yet for shipment', s.id, err instanceof Error ? err.message : err);
    }
  }
  return posted;
}
