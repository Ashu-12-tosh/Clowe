import type { Shipment } from '@prisma/client';
import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { valueOfLines } from './codAmount';
import { shippingProvider } from './index';
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

export async function bookShipment(input: { orderId: string; sellerId: string; itemIds: string[] }): Promise<Shipment> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      items: { include: { product: { include: { category: { select: { hsnCode: true } } } } } },
    },
  });
  const lines = order?.items.filter((i) => input.itemIds.includes(i.id) && i.sellerId === input.sellerId) ?? [];
  if (!order || lines.length !== input.itemIds.length || lines.length === 0) throw ApiError.notFound('Order item not found');
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: input.sellerId } });

  const isCod = order.paymentMethod === 'COD';
  const valuePaise = valueOfLines(order.totalPaise, order.items, input.itemIds);
  const weightGrams = lines.reduce((sum, l) => sum + (l.product.weightGrams ?? FALLBACK_UNIT_GRAMS) * l.quantity, 0);
  // One unit of one product: its own box size. Several go in a box the seller confirms later.
  const single = lines.length === 1 && lines[0]!.quantity === 1 ? lines[0]!.product : null;
  const mode: ShippingMode =
    order.deliveryMethod !== 'STANDARD' || lines.some((l) => l.product.shippingTemplate === 'EXPRESS')
      ? 'EXPRESS'
      : 'SURFACE';

  const shipment = await prisma.$transaction(async (tx) => {
    const row = await tx.shipment.create({
      data: {
        orderId: order.id,
        sellerId: seller.id,
        provider: shippingProvider.name,
        environment: shippingProvider.environment,
        mode,
        paymentType: isCod ? 'COD' : 'PREPAID',
        codAmountPaise: isCod ? valuePaise : 0,
        weightGrams,
        lengthMm: single?.lengthMm ?? null,
        widthMm: single?.widthMm ?? null,
        heightMm: single?.heightMm ?? null,
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
      pickup: { warehouseName: seller.courierWarehouseName, pincode: pickup.pincode },
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
      products: lines.map((l) => ({ title: l.title, quantity: l.quantity, hsn: l.product.category.hsnCode })),
      sellerGstin: seller.gstNumber,
    });
  } catch (err) {
    // Nothing was booked: free the lines and drop the empty parcel.
    await prisma.orderItem.updateMany({ where: { shipmentId: shipment.id }, data: { shipmentId: null } });
    await prisma.shipment.delete({ where: { id: shipment.id } });
    if (err instanceof ShippingProviderError) throw ApiError.badRequest(`Delhivery: ${err.message}`, err.code);
    throw err;
  }
  // Booked: from here on the parcel row stays, whatever happens.
  const [saved] = await prisma.$transaction([
    prisma.shipment.update({
      where: { id: shipment.id },
      data: { awbNumber: booked.awbNumber, estimatedFreightPaise: booked.estimatedFreightPaise },
    }),
    prisma.orderItem.updateMany({
      where: { shipmentId: shipment.id },
      data: { awbNumber: booked.awbNumber, courierName: booked.courierName, trackingUrl: booked.trackingUrl },
    }),
  ]);
  return saved;
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
    } else if (
      live.some((i) => i.status === 'SHIPPED' || i.status === 'DELIVERED') &&
      (s.status === 'CREATED' || s.status === 'PICKUP_REQUESTED')
    ) {
      await prisma.shipment.update({ where: { id: s.id }, data: { status: 'IN_TRANSIT', pickedUpAt: now } });
    }
  }
}
