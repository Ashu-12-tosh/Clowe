import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { valueOfLines } from './codAmount';
import { shippingProvider } from './index';
import { ShippingProviderError } from './ShippingProvider';
import { syncWarehouse } from './warehouses';
import { pincodeServiceability } from './serviceability';

// ---------------------------------------------------------------------------
// Returns, collected by Delhivery.
//
// When a return is approved, a reverse pickup is booked: Delhivery collects
// the item from the buyer's delivery address and brings it to the seller's
// return address from Store Settings, or their pickup address if none is set.
// Delhivery schedules the collection itself. Its scans then mark the return
// picked up, and tell the seller when it has arrived — marking it received,
// with their check of its condition, stays the seller's.
//
// If Delhivery refuses, the return stays approved: the seller and admins are
// told why, and either can try again.
// ---------------------------------------------------------------------------

const FALLBACK_UNIT_GRAMS = 500;

export type ReversePickupOutcome = { booked: true; awbNumber: string } | { booked: false; reason: string };

export async function bookReversePickup(returnId: string): Promise<ReversePickupOutcome> {
  const r = await prisma.return.findUnique({
    where: { id: returnId },
    include: {
      reverseShipment: { select: { id: true, awbNumber: true, status: true } },
      orderItem: {
        include: {
          product: { select: { weightGrams: true, lengthMm: true, widthMm: true, heightMm: true } },
          order: { include: { items: { select: { id: true, pricePaise: true, quantity: true, promoDiscountPaise: true } } } },
        },
      },
    },
  });
  if (!r) throw ApiError.notFound('Return not found');
  if (r.status !== 'APPROVED') throw ApiError.badRequest('Only an approved return is collected', 'RETURN_NOT_APPROVED');
  if (r.reverseShipment && r.reverseShipment.status !== 'CANCELLED') {
    return { booked: true, awbNumber: r.reverseShipment.awbNumber ?? '' };
  }
  const item = r.orderItem;
  const order = item.order;

  const fail = async (reason: string): Promise<ReversePickupOutcome> => {
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: item.sellerId }, select: { userId: true } });
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    await prisma.notification.createMany({
      data: [seller.userId, ...admins.map((a) => a.id)].map((userId) => ({
        userId,
        type: 'RETURN_PICKUP_FAILED',
        title: `Return pickup not booked — ${r.rmaNumber}`,
        body: `${reason}. Book it again from the returns desk.`,
        linkHref: '/seller/returns',
      })),
    });
    return { booked: false, reason };
  };

  // A claim from where the courier does not collect returns (Return Policy
  // 7.2): the buyer sends it themselves and is reimbursed up to ₹100.
  if (r.rules === 'CLAIM') {
    const check = await pincodeServiceability(order.shipPincode);
    if (check && !check.reversePickup) {
      if (!r.selfShip) {
        await prisma.return.update({ where: { id: r.id }, data: { selfShip: true } });
        await prisma.notification.create({
          data: {
            userId: r.userId,
            type: 'RETURN_SELF_SHIP',
            title: `Please send your return yourself — ${r.rmaNumber}`,
            body: `The courier does not collect returns from ${order.shipPincode}. Send "${item.title}" to the seller's address shown in My Returns, then upload the courier receipt: we reimburse up to ₹100.`,
            linkHref: '/account/returns',
          },
        });
      }
      return { booked: false, reason: `Returns are not collected from ${order.shipPincode}: the buyer sends it themselves` };
    }
  }

  const warehouse = await syncWarehouse(item.sellerId);
  if (warehouse.status !== 'ACTIVE' || !warehouse.name) {
    return fail(`The seller's pickup address isn't registered with Delhivery — ${warehouse.error ?? 'try again shortly'}`);
  }

  const weightGrams = (item.product.weightGrams ?? FALLBACK_UNIT_GRAMS) * item.quantity;
  const single = item.quantity === 1 ? item.product : null;
  const shipment = await prisma.shipment.create({
    data: {
      kind: 'REVERSE',
      orderId: order.id,
      sellerId: item.sellerId,
      returnId: r.id,
      provider: shippingProvider.name,
      environment: shippingProvider.environment,
      paymentType: 'PICKUP',
      weightGrams,
      lengthMm: single?.lengthMm ?? null,
      widthMm: single?.widthMm ?? null,
      heightMm: single?.heightMm ?? null,
    },
  });
  try {
    const booked = await shippingProvider.createReversePickup({
      reference: shipment.id,
      orderNumber: order.orderNumber,
      customer: {
        name: order.shipName,
        phone: order.shipPhone,
        line1: order.shipLine1,
        line2: order.shipLine2,
        city: order.shipCity,
        state: order.shipState,
        pincode: order.shipPincode,
      },
      // The seller's return address when set (its own warehouse), else pickup.
      warehouseName: warehouse.returnName ?? warehouse.name,
      valuePaise: valueOfLines(order.totalPaise, order.items, [item.id]),
      weightGrams,
      lengthMm: shipment.lengthMm,
      widthMm: shipment.widthMm,
      heightMm: shipment.heightMm,
      products: [{ title: item.title, quantity: item.quantity, hsn: null }],
    });
    // Delhivery schedules the collection itself: it is asked for already.
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { awbNumber: booked.awbNumber, status: 'PICKUP_REQUESTED', pickupRequestedAt: new Date() },
    });
    await prisma.notification.create({
      data: {
        userId: r.userId,
        type: 'RETURN_PICKUP_BOOKED',
        title: 'Return pickup booked 🚚',
        body: `Delhivery will collect "${item.title}" from your delivery address (AWB ${booked.awbNumber}). Please keep it packed.`,
        linkHref: '/account/returns',
      },
    });
    return { booked: true, awbNumber: booked.awbNumber };
  } catch (err) {
    await prisma.shipment.delete({ where: { id: shipment.id } });
    if (err instanceof ShippingProviderError) return fail(`Delhivery: ${err.message}`);
    throw err;
  }
}

/** Approval never waits on the courier: a refusal is reported, not raised. */
export function bookReversePickupSafe(returnId: string): Promise<void> {
  return bookReversePickup(returnId).then(
    () => undefined,
    (err) => console.error('[clowe-api] return pickup not booked for', returnId, err),
  );
}

/** A scan on a reverse parcel: picked up from the buyer, or delivered back to the seller. */
export async function applyReverseScan(
  shipment: { id: string; returnId: string | null; sellerId: string; awbNumber: string | null },
  status: 'IN_TRANSIT' | 'DELIVERED',
  at: Date,
): Promise<void> {
  if (!shipment.returnId) return;
  if (status === 'IN_TRANSIT') {
    await prisma.return.updateMany({ where: { id: shipment.returnId, pickedUpAt: null }, data: { pickedUpAt: at } });
    return;
  }
  const r = await prisma.return.findUniqueOrThrow({ where: { id: shipment.returnId }, select: { rmaNumber: true, pickedUpAt: true } });
  if (!r.pickedUpAt) await prisma.return.update({ where: { id: shipment.returnId }, data: { pickedUpAt: at } });
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: shipment.sellerId }, select: { userId: true } });
  await prisma.notification.create({
    data: {
      userId: seller.userId,
      type: 'RETURN_ARRIVED',
      title: `Return delivered to you — ${r.rmaNumber}`,
      body: `Delhivery has delivered the return (AWB ${shipment.awbNumber ?? '—'}). Inspect it and mark it received from the returns desk.`,
      linkHref: '/seller/returns',
    },
  });
}
