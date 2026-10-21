import type { Shipment } from '@prisma/client';
import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { valueOfLines, type LineValue } from './codAmount';
import { chargeableGrams, codFeePaise, forwardFreightPaise, postCodFee, postForwardFreight, postRtoFreight } from './freight';
import { shippingProvider } from './index';
import { gstRateForInclusive, isValidHsn } from '@clowe/shared';
import { categoryRulesMap } from '../categoryRules';
import { gstSettings } from '../economicsRates';
import { getSettings } from '../settingsService';
import { raiseWalletAlertIfWallet } from './walletAlert';
import { syncWarehouse } from './warehouses';
import { ShippingProviderError, type ShippingMode } from './ShippingProvider';

// ---------------------------------------------------------------------------
// A seller's lines of an order, booked with the courier as one parcel.
//
// The lines are claimed for a new Shipment row first, so two clicks can't
// book the same line twice; the courier is called only then, and if it
// refuses, the claim is released and the row removed — nothing was booked.
// The lines keep display copies of the AWB, courier and tracking link.
// ---------------------------------------------------------------------------

/** What a parcel weighs when a listing has no weight yet: one 500 g slab per unit. */
const FALLBACK_UNIT_GRAMS = 500;

/** The seller's pickup address, as their labels and the courier use it. */
export function pickupAddress(seller: {
  pickupSameAsBusiness: boolean;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  pickupLine1: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  pickupPincode: string | null;
}) {
  return seller.pickupSameAsBusiness
    ? { line1: seller.addressLine1, city: seller.city, state: seller.state, pincode: seller.pincode }
    : { line1: seller.pickupLine1, city: seller.pickupCity, state: seller.pickupState, pincode: seller.pickupPincode };
}

export interface ParcelPlan {
  isCod: boolean;
  /** The lines' share of what the buyer owes. */
  valuePaise: number;
  codAmountPaise: number;
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** Surface: Express is not offered for now. */
  mode: ShippingMode;
}

/**
 * What the goods in a parcel are worth, as the courier is told (the invoice
 * value) and as the label prints it: the lines' share of what the buyer paid.
 * A free replacement's order total is ₹0; the courier still needs the goods'
 * value, so there it is the lines' own price.
 */
export function declaredValueOf(order: { paymentMethod: string; totalPaise: number; items: LineValue[] }, lineIds: Iterable<string>): number {
  const ids = new Set(lineIds);
  return order.paymentMethod === 'REPLACEMENT'
    ? order.items.filter((i) => ids.has(i.id)).reduce((sum, i) => sum + i.pricePaise * i.quantity - i.promoDiscountPaise, 0)
    : valueOfLines(order.totalPaise, order.items, ids);
}

/** Each category's valid HSN code (its own or inherited), or null. */
export async function hsnByCategory(categoryIds: Iterable<string>): Promise<Map<string, string | null>> {
  const rules = await categoryRulesMap(categoryIds);
  const out = new Map<string, string | null>();
  for (const [id, r] of rules) out.set(id, isValidHsn(r?.hsnCode) ? r!.hsnCode!.trim() : null);
  return out;
}

/** One parcel for these lines of an order: what it weighs, measures and collects. */
export function planParcel(
  order: { paymentMethod: string; totalPaise: number; items: LineValue[] },
  lines: { id: string; quantity: number; product: { weightGrams: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null } }[],
): ParcelPlan {
  const isCod = order.paymentMethod === 'COD';
  const valuePaise = declaredValueOf(order, lines.map((l) => l.id));
  // One unit of one product: its own box size. Several go in a box the seller confirms later.
  const single = lines.length === 1 && lines[0]!.quantity === 1 ? lines[0]!.product : null;
  return {
    isCod,
    valuePaise,
    codAmountPaise: isCod ? valuePaise : 0,
    weightGrams: lines.reduce((sum, l) => sum + (l.product.weightGrams ?? FALLBACK_UNIT_GRAMS) * l.quantity, 0),
    lengthMm: single?.lengthMm ?? null,
    widthMm: single?.widthMm ?? null,
    heightMm: single?.heightMm ?? null,
    mode: 'SURFACE',
  };
}

export async function bookShipment(input: {
  orderId: string;
  sellerId: string;
  itemIds: string[];
  /** The box as the seller confirmed it; the products' figures when absent. */
  box?: { weightGrams: number; lengthMm: number; widthMm: number; heightMm: number };
}): Promise<Shipment> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      items: { include: { product: { include: { category: { select: { id: true, name: true } } } } } },
    },
  });
  const lines = order?.items.filter((i) => input.itemIds.includes(i.id) && i.sellerId === input.sellerId) ?? [];
  if (!order || lines.length !== input.itemIds.length || lines.length === 0) throw ApiError.notFound('Order item not found');
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: input.sellerId } });
  // Delhivery collects from the seller's registered pickup address. Not
  // registered yet (or changed since): register it now, or refuse with why.
  let warehouseName = seller.courierWarehouseStatus === 'ACTIVE' ? seller.courierWarehouseName : null;
  if (!warehouseName) {
    const sync = await syncWarehouse(seller.id);
    if (sync.status !== 'ACTIVE' || !sync.name) {
      throw ApiError.badRequest(
        `Your pickup address isn't registered with Delhivery yet — ${sync.error ?? 'try again shortly'}`,
        'PICKUP_ADDRESS_NOT_READY',
      );
    }
    warehouseName = sync.name;
  }

  const plan = { ...planParcel(order, lines), ...(input.box ?? {}) };
  const { isCod, valuePaise, weightGrams, mode } = plan;

  const shipment = await prisma.$transaction(async (tx) => {
    const row = await tx.shipment.create({
      data: {
        orderId: order.id,
        sellerId: seller.id,
        provider: shippingProvider.name,
        environment: shippingProvider.environment,
        mode,
        paymentType: isCod ? 'COD' : 'PREPAID',
        codAmountPaise: plan.codAmountPaise,
        weightGrams,
        lengthMm: plan.lengthMm,
        widthMm: plan.widthMm,
        heightMm: plan.heightMm,
      },
    });
    const claimed = await tx.orderItem.updateMany({
      where: { id: { in: input.itemIds }, shipmentId: null },
      data: { shipmentId: row.id },
    });
    if (claimed.count !== input.itemIds.length) {
      throw ApiError.badRequest('This item is already booked with the courier', 'ALREADY_BOOKED');
    }
    return row;
  });

  const pickup = pickupAddress(seller);
  let booked;
  try {
    booked = await shippingProvider.createShipment({
      reference: shipment.id,
      orderNumber: order.orderNumber,
      pickup: { warehouseName, pincode: pickup.pincode },
      consignee: {
        name: order.shipName,
        phone: order.shipPhone,
        line1: order.shipLine1,
        line2: order.shipLine2,
        city: order.shipCity,
        state: order.shipState,
        pincode: order.shipPincode,
      },
      payment: isCod ? 'COD' : 'PREPAID',
      codAmountPaise: shipment.codAmountPaise,
      invoiceValuePaise: valuePaise,
      mode,
      weightGrams,
      lengthMm: shipment.lengthMm,
      widthMm: shipment.widthMm,
      heightMm: shipment.heightMm,
      products: await shipmentProducts(lines),
      sellerGstin: seller.gstNumber,
    });
  } catch (err) {
    // Nothing was booked: free the lines and drop the empty parcel.
    await prisma.orderItem.updateMany({ where: { shipmentId: shipment.id }, data: { shipmentId: null } });
    await prisma.shipment.delete({ where: { id: shipment.id } });
    if (err instanceof ShippingProviderError) {
      // Clowe's wallet, not the seller's parcel: admins must recharge it.
      await raiseWalletAlertIfWallet(err.message, `order ${order.orderNumber}, ${seller.shopName}`);
      throw ApiError.badRequest(`Delhivery: ${err.message}`, err.code);
    }
    throw err;
  }
  // Booked: from here on the parcel row stays, whatever happens. The
  // estimate is what the seller saw before confirming, from the charges API.
  const route = pickup.pincode
    ? { originPincode: pickup.pincode, destinationPincode: order.shipPincode, mode, weightGrams: chargeableGrams(plan) }
    : null;
  const estimate = route ? await forwardFreightPaise(route).catch(() => booked.estimatedFreightPaise) : booked.estimatedFreightPaise;
  const codEstimate = route && isCod ? await codFeePaise(route, plan.codAmountPaise).catch(() => null) : isCod ? null : 0;
  const [saved] = await prisma.$transaction([
    prisma.shipment.update({
      where: { id: shipment.id },
      data: { awbNumber: booked.awbNumber, estimatedFreightPaise: estimate, estimatedCodFeePaise: codEstimate },
    }),
    prisma.orderItem.updateMany({
      where: { shipmentId: shipment.id },
      data: { awbNumber: booked.awbNumber, courierName: booked.courierName, trackingUrl: booked.trackingUrl },
    }),
  ]);
  return saved;
}

/**
 * What goes in the box, as Delhivery is told: each line's HSN code and GST
 * rate, worked out exactly as its tax invoice does (the category's rules,
 * inherited down the tree; the rate the line was sold at). A category without
 * a valid HSN code is booked without one, and admins are told — once a day per
 * category — to add it.
 */
export async function shipmentProducts(
  lines: { title: string; quantity: number; pricePaise: number; gstRatePercent: number | null; product: { category: { id: string; name: string } } }[],
): Promise<{ title: string; quantity: number; hsn: string | null; gstRatePercent: number }[]> {
  const rules = await categoryRulesMap(lines.map((l) => l.product.category.id));
  const gst = gstSettings(await getSettings());
  const missing = new Map<string, string>();
  const products = lines.map((l) => {
    const r = rules.get(l.product.category.id);
    const hsn = isValidHsn(r?.hsnCode) ? r!.hsnCode!.trim() : null;
    if (!hsn) missing.set(l.product.category.id, l.product.category.name);
    return { title: l.title, quantity: l.quantity, hsn, gstRatePercent: l.gstRatePercent ?? gstRateForInclusive(l.pricePaise, r, gst).ratePercent };
  });
  if (missing.size > 0) {
    const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    for (const [id, name] of missing) {
      // Once a day per category: the warning is in the admin's notifications already.
      const told = await prisma.notification.findFirst({
        where: { type: 'CATEGORY_HSN_MISSING', linkHref: `/admin/categories?hsn=${id}`, createdAt: { gte: new Date(`${day}T00:00:00+05:30`) } },
        select: { id: true },
      });
      if (told) continue;
      await prisma.notification.createMany({
        data: admins.map((a) => ({
          userId: a.id,
          type: 'CATEGORY_HSN_MISSING',
          title: `Add an HSN code to "${name}"`,
          body: `A parcel from "${name}" was booked with Delhivery without an HSN code, because the category (and its parents) has no valid one. Delhivery asks for the HSN of commercial goods, and invoices show it. Add a 4, 6 or 8-digit HSN code in Categories.`,
          linkHref: `/admin/categories?hsn=${id}`,
        })),
      });
    }
  }
  return products;
}

/**
 * Whether a line may be marked delivered by hand: only on the mock courier.
 * A Delhivery parcel is delivered by Delhivery's delivery scan (or by an
 * admin, with a reason on the audit log) — never by its seller.
 */
export async function deliveredByHandAllowed(shipmentId: string | null): Promise<boolean> {
  if (!shipmentId) return shippingProvider.name === 'mock';
  const parcel = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { provider: true } });
  return (parcel?.provider ?? shippingProvider.name) === 'mock';
}

/**
 * Bring parcels in line with their lines after a seller or admin moved them:
 * on its way once any line shipped, delivered once every live line is.
 * Courier scans take this over once tracking is live.
 */
export async function syncShipmentsFromLines(shipmentIds: Iterable<string | null>): Promise<void> {
  const ids = [...new Set([...shipmentIds].filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  const shipments = await prisma.shipment.findMany({
    where: { id: { in: ids } },
    include: { items: { select: { status: true } } },
  });
  const now = new Date();
  for (const s of shipments) {
    const live = s.items.filter((i) => i.status !== 'CANCELLED');
    if (live.length > 0 && live.every((i) => i.status === 'DELIVERED') && s.status !== 'DELIVERED') {
      await prisma.shipment.update({
        where: { id: s.id },
        data: { status: 'DELIVERED', deliveredAt: now, pickedUpAt: s.pickedUpAt ?? now },
      });
      // Delivered: the seller pays its freight. If the charges API is down
      // it is posted later, before any payout is worked out.
      await postForwardFreight(s.id).catch((err) =>
        console.error('[clowe-api] freight not posted yet for shipment', s.id, err instanceof Error ? err.message : err),
      );
      await postCodFee(s.id).catch((err) =>
        console.error('[clowe-api] COD fee not posted yet for shipment', s.id, err instanceof Error ? err.message : err),
      );
    } else if (live.length > 0 && live.every((i) => i.status === 'RTO_DELIVERED') && s.status !== 'RTO_DELIVERED') {
      // Back with the seller, undelivered: the trip out and the trip back are theirs.
      await prisma.shipment.update({
        where: { id: s.id },
        data: { status: 'RTO_DELIVERED', rtoDeliveredAt: now, rtoInitiatedAt: s.rtoInitiatedAt ?? now },
      });
      await postRtoFreight(s.id).catch((err) =>
        console.error('[clowe-api] RTO freight not posted yet for shipment', s.id, err instanceof Error ? err.message : err),
      );
    } else if (
      live.some((i) => i.status === 'SHIPPED' || i.status === 'DELIVERED') &&
      (s.status === 'CREATED' || s.status === 'PICKUP_REQUESTED')
    ) {
      await prisma.shipment.update({ where: { id: s.id }, data: { status: 'IN_TRANSIT', pickedUpAt: now } });
    }
  }
}
