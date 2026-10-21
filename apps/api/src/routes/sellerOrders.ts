import { Router } from 'express';
import { z } from 'zod';
import type { Prisma, SellerProfile } from '@prisma/client';
import {
  packingVideoAttachSchema,
  COURIER_DELIVERS_MESSAGE,
  PACKING_VIDEO_REQUIRED_MESSAGE,
  SELLER_ORDER_TABS,
  SELLER_ORDER_TAB_LABELS,
  SELLER_ORDER_TAB_STATUSES,
  SELLER_ORDER_SORTS,
  SELLER_PAYMENT_FILTERS,
  sellerOrderActionSchema,
  sellerOrderBulkSchema,
  parcelNdrSchema,
  parcelRtoReceivedSchema,
  sellerBookingQuoteSchema,
  type ParcelBox,
  sellerOrderCancelSchema,
  type SellerInvoice,
  type SellerOrderBulkResult,
  type SellerOrderLine,
  type SellerOrderPage,
  type SellerOrderRow,
  type SellerOrderSort,
  type SellerOrderSummary,
  type SellerOrderTab,
  type SellerQr,
  type SellerShippingLabel,
  type SellerBookingQuote,
  isNotASale,
  type CreditNote,
} from '@clowe/shared';
import QRCode from 'qrcode';
import { prisma } from '../db';
import { creditNotesFor } from '../services/creditNotes';
import { buildTaxInvoice } from '../services/taxInvoice';
import { webPublicUrl } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { auditSafe, deviceFromUserAgent, ipFrom } from '../services/auditService';
import { shippingProvider } from '../services/shipping';
import { bookShipment, deliveredByHandAllowed, pickupAddress, planParcel } from '../services/shipping/shipments';
import { separateReturnAddress } from '../services/shipping/warehouses';
import { markLineDelivered, markLineShipped } from '../services/shipping/lineTransitions';
import { requestPickup } from '../services/shipping/pickups';
import { receiveRto, requestNdrAction } from '../services/shipping/rto';
import { chargeableGrams, codFeePaise, forwardFreightPaise } from '../services/shipping/freight';
import { valueOfLines } from '../services/shipping/codAmount';
import { checkSellerReferralReward } from '../services/sellerReferralService';
import { blockSuspendedWrites, requireSeller } from './seller';
import { removeStoredFile } from './uploads';
import { assertOwnAssets } from '../services/assets';
import { hasPackingVideo, packingVideoView } from '../services/packingVideos';
import {
  aggregateStatus,
  syncOrderStatus,
} from '../services/orderStatusService';
import { cancelSellerPart } from '../services/sellerCancellation';
import {
  dispatchClock,
  dispatchContext,
  type DispatchContext,
} from '../services/lateDispatch';

export const sellerOrdersRouter = Router();
sellerOrdersRouter.use(requireAuth, requireSeller, blockSuspendedWrites);

/** Ceiling on orders scanned when sorting/aggregating in memory. */
const SCAN_CAP = 5000;
/** Items scanned for the KPI tiles. */
const ITEM_CAP = 20000;

/**
 * QR printed on labels and invoices: scanning it opens the order in the seller
 * panel. Each document gets its own URL (item / invoice ref), so codes are unique.
 */
async function sellerOrderQr(orderId: string, ref: Record<string, string>): Promise<SellerQr> {
  const url = new URL(`/seller/orders/${orderId}`, webPublicUrl);
  for (const [key, value] of Object.entries(ref)) url.searchParams.set(key, value);
  const dataUrl = await QRCode.toDataURL(url.toString(), {
    margin: 1,
    width: 256,
    errorCorrectionLevel: 'M',
  });
  return { url: url.toString(), dataUrl };
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const listQuery = z.object({
  tab: z.enum(SELLER_ORDER_TABS).default('ALL'),
  q: z.string().trim().max(80).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  payment: z.enum(SELLER_PAYMENT_FILTERS).default('ALL'),
  sort: z.enum(SELLER_ORDER_SORTS).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});

function dateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  const gte = from ? new Date(`${from}T00:00:00`) : undefined;
  const lte = to ? new Date(`${to}T23:59:59.999`) : undefined;
  if (!gte && !lte) return undefined;
  return {
    ...(gte && !Number.isNaN(gte.getTime()) ? { gte } : {}),
    ...(lte && !Number.isNaN(lte.getTime()) ? { lte } : {}),
  };
}

/** Orders that contain at least one line from this seller, minus unpaid ones. */
function buildOrderWhere(
  sellerId: string,
  query: z.infer<typeof listQuery>,
): Prisma.OrderWhereInput {
  const statuses = SELLER_ORDER_TAB_STATUSES[query.tab as SellerOrderTab];
  const created = dateRange(query.from, query.to);

  const where: Prisma.OrderWhereInput = {
    // PLACED = payment not completed; those stay hidden from sellers.
    status: { not: 'PLACED' },
    items: {
      some: {
        sellerId,
        ...(statuses ? { status: { in: statuses as Prisma.EnumOrderStatusFilter['in'] } } : {}),
      },
    },
    ...(created ? { createdAt: created } : {}),
  };

  switch (query.payment) {
    case 'PAID':
      where.payment = { status: 'PAID' };
      break;
    case 'REFUNDED':
      where.payment = { status: 'REFUNDED' };
      break;
    case 'COD':
      where.paymentMethod = 'COD';
      break;
    case 'PENDING':
      where.AND = [
        { paymentMethod: { not: 'COD' } },
        { OR: [{ payment: { is: null } }, { payment: { status: { in: ['CREATED', 'FAILED'] } } }] },
      ];
      break;
    default:
      break;
  }

  if (query.q) {
    const q = query.q;
    where.OR = [
      { orderNumber: { contains: q, mode: 'insensitive' } },
      { shipName: { contains: q, mode: 'insensitive' } },
      { shipPincode: { contains: q } },
      { user: { name: { contains: q, mode: 'insensitive' } } },
      { items: { some: { sellerId, title: { contains: q, mode: 'insensitive' } } } },
      { items: { some: { sellerId, awbNumber: { contains: q, mode: 'insensitive' } } } },
      { items: { some: { sellerId, courierName: { contains: q, mode: 'insensitive' } } } },
    ];
  }

  return where;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const ORDER_INCLUDE = (sellerId: string) =>
  ({
    user: { select: { name: true, rtoCount: true } },
    payment: { select: { status: true } },
    shipments: {
      where: { sellerId, kind: 'FORWARD' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, awbNumber: true, status: true, statusText: true, ndrAction: true, ndrActionAt: true, rtoReceivedCondition: true, deliveryAttempts: true,
        items: { select: { id: true } },
      },
    },
    items: {
      where: { sellerId },
      include: {
        product: { select: { slug: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
        return: { select: { id: true, status: true } },
        shipment: { select: { provider: true, status: true, pickupScheduledFor: true, pickupFailedAt: true } },
      },
    },
    packingVideos: { where: { sellerId }, select: { uploadedAt: true, deletedAt: true } },
  }) satisfies Prisma.OrderInclude;

type OrderRecord = Prisma.OrderGetPayload<{ include: ReturnType<typeof ORDER_INCLUDE> }>;

function paymentStatusOf(order: OrderRecord): string {
  const status = order.payment?.status;
  // A COD order carries a CREATED payment row until the cash is collected —
  // reporting that as "CREATED" reads like a failed prepayment.
  if (order.paymentMethod === 'COD' && status !== 'PAID' && status !== 'REFUNDED') {
    return 'COD_PENDING';
  }
  return status ?? 'CREATED';
}

// aggregateStatus / syncOrderStatus / settleCodIfDelivered now live in
// services/orderStatusService so the admin order desk shares one definition of
// what an order's status is.

function toLine(item: OrderRecord['items'][number], orderCancelled: boolean): SellerOrderLine {
  return {
    id: item.id,
    productId: item.productId,
    title: item.title,
    slug: item.product.slug,
    imageUrl: item.product.images[0]?.url ?? null,
    size: item.size,
    color: item.color,
    label: item.variantLabel,
    quantity: item.quantity,
    pricePaise: item.pricePaise,
    status: item.status,
    awbNumber: item.awbNumber,
    courierName: item.courierName,
    trackingUrl: item.trackingUrl,
    shipmentId: item.shipmentId,
    packedAt: item.packedAt?.toISOString() ?? null,
    shippedAt: item.shippedAt?.toISOString() ?? null,
    deliveredAt: item.deliveredAt?.toISOString() ?? null,
    returnId: item.return?.id ?? null,
    returnStatus: item.return?.status ?? null,
    pickupScheduledFor: item.shipment?.status === 'PICKUP_REQUESTED' ? (item.shipment.pickupScheduledFor?.toISOString() ?? null) : null,
    pickupFailedAt: item.shipment?.status === 'CREATED' ? (item.shipment.pickupFailedAt?.toISOString() ?? null) : null,
    canAssign: !orderCancelled && (item.status === 'CONFIRMED' || item.status === 'PACKED') && !item.shipmentId,
    canPack: !orderCancelled && item.status === 'CONFIRMED',
    // Ready for pickup: until Delhivery has been asked to come for its parcel.
    canShip:
      !orderCancelled &&
      (item.status === 'CONFIRMED' || item.status === 'PACKED') &&
      (!item.shipment || item.shipment.status === 'CREATED'),
    // Only on the mock courier: a Delhivery parcel is delivered by its scan.
    canDeliver: !orderCancelled && item.status === 'SHIPPED' && (item.shipment?.provider ?? shippingProvider.name) === 'mock',
  };
}

/** `dispatch` carries the clocks for screens that show them; the CSV export passes none. */
function toRow(order: OrderRecord, dispatch?: DispatchContext): SellerOrderRow {
  const lines = order.items.map((i) => toLine(i, order.status === 'CANCELLED'));
  const { status, mixed } = aggregateStatus(lines);
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    placedAt: order.createdAt.toISOString(),
    // Name + address only - sellers never receive buyer contact details.
    customer: { name: order.user.name ?? order.shipName },
    shipTo: {
      name: order.shipName,
      line1: order.shipLine1,
      line2: order.shipLine2,
      city: order.shipCity,
      state: order.shipState,
      pincode: order.shipPincode,
    },
    lines,
    itemCount: lines.length,
    unitCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    amountPaise: lines.reduce((sum, l) => sum + l.pricePaise * l.quantity, 0),
    paymentMethod: order.paymentMethod,
    paymentStatus: paymentStatusOf(order),
    isCod: order.paymentMethod === 'COD',
    deliveryMethod: order.deliveryMethod,
    isGift: order.isGift,
    status,
    mixedStatus: mixed,
    // The link is signed per view, on the order page only.
    packingVideo: order.packingVideos[0]
      ? {
          url: null,
          uploadedAt: order.packingVideos[0].uploadedAt.toISOString(),
          deleted: order.packingVideos[0].deletedAt !== null,
        }
      : null,
    dispatch:
      dispatch && order.status !== 'CANCELLED'
        ? dispatchClock({
            placedAt: order.createdAt,
            lines: order.items,
            settings: dispatch.settings,
            vacation: dispatch.vacation,
            penaltyCharged: dispatch.penalized.has(order.id),
          })
        : null,
    parcels: order.shipments.map((p) => ({
      id: p.id,
      awbNumber: p.awbNumber,
      status: p.status,
      statusText: p.statusText,
      itemIds: p.items.map((x) => x.id),
      ndrAction: p.ndrAction,
      ndrActionAt: p.ndrActionAt?.toISOString() ?? null,
      rtoReceivedCondition: p.rtoReceivedCondition,
      deliveryAttempts: p.deliveryAttempts,
      deliverTo: { line1: order.shipLine1, line2: order.shipLine2, city: order.shipCity, pincode: order.shipPincode },
    })),
    buyerRtoCount: order.user.rtoCount,
  };
}

// ---------------------------------------------------------------------------
// GET / — the order table
// ---------------------------------------------------------------------------

sellerOrdersRouter.get('/', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const query = listQuery.parse(req.query);
    const where = buildOrderWhere(sellerId, query);

    // Amount sorting is on the seller's share, which isn't a column — so the
    // matching set is scanned light (ids + line prices), ordered, then paged.
    const matches = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      select: {
        id: true,
        createdAt: true,
        items: { where: { sellerId }, select: { pricePaise: true, quantity: true } },
      },
    });

    const ranked = matches
      .map((o) => ({
        id: o.id,
        createdAt: o.createdAt.getTime(),
        amount: o.items.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0),
      }))
      .sort((a, b) => compare(a, b, query.sort));

    const total = ranked.length;
    const pageIds = ranked
      .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
      .map((o) => o.id);

    const orders = pageIds.length
      ? await prisma.order.findMany({
          where: { id: { in: pageIds } },
          include: ORDER_INCLUDE(sellerId),
        })
      : [];
    const ctx = await dispatchContext(sellerId, pageIds);

    // findMany doesn't preserve `in` order — restore the ranking.
    const byId = new Map(orders.map((o) => [o.id, o]));
    const rows = pageIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((o) => toRow(o!, ctx));

    const body: SellerOrderPage = {
      rows,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

function compare(
  a: { createdAt: number; amount: number },
  b: { createdAt: number; amount: number },
  sort: SellerOrderSort,
): number {
  switch (sort) {
    case 'OLDEST':
      return a.createdAt - b.createdAt;
    case 'AMOUNT_HIGH':
      return b.amount - a.amount;
    case 'AMOUNT_LOW':
      return a.amount - b.amount;
    default:
      return b.createdAt - a.createdAt;
  }
}

// ---------------------------------------------------------------------------
// GET /summary — KPI tiles, shop overview, shipping modes, refund requests
// ---------------------------------------------------------------------------

sellerOrdersRouter.get('/summary', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const query = listQuery.parse({ ...req.query, tab: 'ALL' });
    const created = dateRange(query.from, query.to);

    const items = await prisma.orderItem.findMany({
      where: {
        sellerId,
        order: { status: { not: 'PLACED' }, ...(created ? { createdAt: created } : {}) },
      },
      take: ITEM_CAP,
      select: {
        orderId: true,
        status: true,
        pricePaise: true,
        quantity: true,
      },
    });

    const value = (predicate: (i: (typeof items)[number]) => boolean) => {
      const matched = items.filter(predicate);
      return {
        count: matched.length,
        valuePaise: matched.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0),
      };
    };

    const tiles = SELLER_ORDER_TABS.filter((t) => t !== 'ALL').map((tab) => {
      const statuses = SELLER_ORDER_TAB_STATUSES[tab]!;
      const { count, valuePaise } = value((i) => statuses.includes(i.status));
      return { key: tab, label: SELLER_ORDER_TAB_LABELS[tab], count, valuePaise };
    });

    // Sales exclude cancelled/returned lines, matching the dashboard's revenue.
    const sold = items.filter((i) => !isNotASale(i.status));
    const totalSalesPaise = sold.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
    const totalOrders = new Set(items.map((i) => i.orderId)).size;
    const units = items.reduce((sum, i) => sum + i.quantity, 0);
    const returnedUnits = items
      .filter((i) => ['RETURNED', 'RETURN_REQUESTED'].includes(i.status))
      .reduce((sum, i) => sum + i.quantity, 0);
    const cancelledUnits = items
      .filter((i) => i.status === 'CANCELLED')
      .reduce((sum, i) => sum + i.quantity, 0);

    // Parcels booked with Delhivery, by service.
    const modes = await prisma.shipment.groupBy({
      by: ['mode'],
      where: {
        sellerId,
        kind: 'FORWARD',
        status: { not: 'CANCELLED' },
        ...(created ? { order: { createdAt: created } } : {}),
      },
      _count: { _all: true },
    });
    const parcels = modes.reduce((sum, m) => sum + m._count._all, 0);

    const returns = await prisma.return.findMany({
      where: { orderItem: { sellerId } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        orderItem: {
          select: {
            id: true,
            title: true,
            pricePaise: true,
            quantity: true,
            order: { select: { orderNumber: true } },
          },
        },
      },
    });

    const body: SellerOrderSummary = {
      tiles,
      overview: {
        totalOrders,
        totalSalesPaise,
        avgOrderValuePaise: totalOrders > 0 ? Math.round(totalSalesPaise / totalOrders) : 0,
        returnRate: units > 0 ? Math.round((returnedUnits / units) * 1000) / 10 : 0,
        cancelRate: units > 0 ? Math.round((cancelledUnits / units) * 1000) / 10 : 0,
      },
      shippingModes: modes
        .map((m) => ({
          mode: m.mode,
          label: m.mode === 'EXPRESS' ? 'Express' : 'Surface',
          count: m._count._all,
          share: parcels > 0 ? Math.round((m._count._all / parcels) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count),
      recentRefunds: returns.map((r) => ({
        returnId: r.id,
        orderItemId: r.orderItemId,
        orderNumber: r.orderItem.order.orderNumber,
        title: r.orderItem.title,
        amountPaise: r.orderItem.pricePaise * r.orderItem.quantity,
        status: r.status,
        requestedAt: r.createdAt.toISOString(),
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Fulfilment transitions
// ---------------------------------------------------------------------------

type Action = 'pack' | 'ship' | 'deliver';

type ItemForAction = Prisma.OrderItemGetPayload<{
  include: { order: { include: { user: { select: { id: true; phone: true } } } } };
}>;

const ACTION_INCLUDE = { order: { include: { user: { select: { id: true, phone: true } } } } } as const;

/** Why a line can't be booked with the courier now; null when it can. */
function bookingProblem(item: ItemForAction): string | null {
  if (item.order.status === 'CANCELLED') return 'Order was cancelled';
  if (item.status !== 'CONFIRMED' && item.status !== 'PACKED') {
    return `Cannot book a shipment for an item in status ${item.status}`;
  }
  if (item.shipmentId) return `Already booked with Delhivery — AWB ${item.awbNumber ?? 'pending'}`;
  return null;
}

/**
 * Book lines with Delhivery before they leave, so the label carries the AWB:
 * one parcel per order for the lines given together. No packing video needed
 * yet — the label goes on before the clip is filmed. Returns the reason for
 * each line that was not booked.
 */
async function bookLines(items: ItemForAction[], boxes?: Record<string, ParcelBox>): Promise<Map<string, string>> {
  const skipped = new Map<string, string>();
  const byOrder = new Map<string, ItemForAction[]>();
  for (const item of items) {
    const problem = bookingProblem(item);
    if (problem) skipped.set(item.id, problem);
    else byOrder.set(item.orderId, [...(byOrder.get(item.orderId) ?? []), item]);
  }
  for (const [orderId, lines] of byOrder) {
    try {
      await bookShipment({ orderId, sellerId: lines[0]!.sellerId, itemIds: lines.map((l) => l.id), box: boxes?.[orderId] });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      for (const l of lines) skipped.set(l.id, err.message);
    }
  }
  return skipped;
}

/**
 * Moves one line to the next stage. Returns null on success or the reason it
 * was skipped — bulk uses the reason, single-item raises it as an error.
 */
async function applyAction(item: ItemForAction, action: Action): Promise<string | null> {
  if (item.order.status === 'CANCELLED') return 'Order was cancelled';

  if (action === 'pack') {
    if (item.status !== 'CONFIRMED') return `Cannot pack an item in status ${item.status}`;
    // Packed means it went into the box, which is what the clip shows.
    if (!(await hasPackingVideo(item.orderId, item.sellerId))) return PACKING_VIDEO_REQUIRED_MESSAGE;
    await prisma.$transaction([
      prisma.orderItem.update({
        where: { id: item.id },
        data: { status: 'PACKED', packedAt: new Date() },
      }),
      prisma.notification.create({
        data: {
          userId: item.order.user.id,
          type: 'ITEM_PACKED',
          title: 'Your order is packed 📦',
          body: `"${item.title}" (${item.order.orderNumber}) has been packed and is waiting for courier pickup.`,
          linkHref: `/account/orders/${item.orderId}`,
        },
      }),
    ]);
    await syncOrderStatus(item.orderId);
    return null;
  }

  if (action === 'ship') {
    // Packing as a step is optional — a seller can ship straight from a new
    // order — but the packing video is not: no clip, no dispatch.
    if (item.status !== 'CONFIRMED' && item.status !== 'PACKED') {
      return `Cannot ship an item in status ${item.status}`;
    }
    if (!(await hasPackingVideo(item.orderId, item.sellerId))) return PACKING_VIDEO_REQUIRED_MESSAGE;
    // The parcel booked earlier (and printed on the label) is the one that
    // goes; a line not booked yet is booked now.
    if (!item.shipmentId) {
      const reason = (await bookLines([item])).get(item.id);
      if (reason) return reason;
    }
    const { shipmentId } = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id }, select: { shipmentId: true } });
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId! } });
    // Shipping is handing the parcel to Delhivery: ask it to collect. The line
    // is Shipped once Delhivery's pickup scan says so (the mock collects at
    // once). A parcel already asked for — or already collected with another
    // line of its box — is fine as it is.
    if (shipment.status === 'CREATED') {
      try {
        await requestPickup({ sellerId: item.sellerId, shipmentIds: [shipment.id] });
      } catch (err) {
        if (err instanceof ApiError) return err.message;
        throw err;
      }
    } else if (shippingProvider.name === 'mock') {
      await markLineShipped(item.id);
    }
    return null;
  }

  if (item.status !== 'SHIPPED') return `Cannot deliver an item in status ${item.status}`;
  if (!(await deliveredByHandAllowed(item.shipmentId))) return COURIER_DELIVERS_MESSAGE;
  await markLineDelivered(item.id);
  return null;
}

// Single line: book / pack / ship / deliver.
sellerOrdersRouter.patch('/:itemId/status', async (req, res, next) => {
  try {
    const input = sellerOrderActionSchema.parse(req.body);
    const item = await prisma.orderItem.findUnique({ where: { id: req.params.itemId }, include: ACTION_INCLUDE });
    if (!item || item.sellerId !== req.seller!.id) throw ApiError.notFound('Order item not found');

    const skipped =
      input.action === 'assign'
        ? ((await bookLines([item])).get(item.id) ?? null)
        : await applyAction(item, input.action);
    if (skipped) {
      throw ApiError.badRequest(skipped, skipped === PACKING_VIDEO_REQUIRED_MESSAGE ? 'PACKING_VIDEO_REQUIRED' : undefined);
    }

    if (input.action === 'deliver') {
      checkSellerReferralReward(req.seller!.id).catch((err) =>
        console.error('[clowe-api] referral reward check failed:', err),
      );
    }
    res.json({ success: true, data: { id: item.id } });
  } catch (err) {
    next(err);
  }
});

// After a failed delivery attempt: ask Delhivery to try again, to deliver on a
// later day, to deliver to a corrected address (same PIN code), or to bring it
// back. Sellers never see the buyer's phone, so they can't change it.
sellerOrdersRouter.post('/parcels/:shipmentId/ndr', async (req, res, next) => {
  try {
    const input = parcelNdrSchema.parse(req.body);
    if (input.phone) throw ApiError.badRequest("Only Clowe can change the buyer's phone — ask support", 'NDR_PHONE_ADMIN_ONLY');
    const result = await requestNdrAction({
      shipmentId: req.params.shipmentId,
      sellerId: req.seller!.id,
      action: input.action,
      deferTo: input.deferTo ? new Date(`${input.deferTo}T12:00:00+05:30`) : undefined,
      consignee: { line1: input.line1, line2: input.line2 || null },
    });
    if (input.action === 'EDIT_DETAILS' || input.action === 'RETURN_TO_SELLER') {
      auditSafe({
        actorId: req.auth!.userId,
        actorRole: 'SELLER',
        module: 'ORDERS',
        action: input.action === 'EDIT_DETAILS' ? 'Delivery address corrected' : 'Return to seller requested',
        entityType: 'Shipment',
        entityId: req.params.shipmentId,
        summary:
          input.action === 'EDIT_DETAILS'
            ? `After a failed delivery, asked Delhivery to deliver to: ${[input.line1, input.line2].filter(Boolean).join(', ')}`
            : 'After a failed delivery, asked Delhivery to bring the parcel back',
        metadata: { action: input.action, line1: input.line1 ?? null, line2: input.line2 || null },
        severity: 'MEDIUM',
        ipAddress: ipFrom(req),
        userAgent: req.get('user-agent') ?? null,
        deviceType: deviceFromUserAgent(req.get('user-agent')),
      });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// The parcel is back with the seller (RTO): in good condition its stock goes
// back on sale; damaged, an admin is told.
sellerOrdersRouter.post('/parcels/:shipmentId/rto-received', async (req, res, next) => {
  try {
    const { condition } = parcelRtoReceivedSchema.parse(req.body);
    await receiveRto({ shipmentId: req.params.shipmentId, sellerId: req.seller!.id, condition, actorId: req.auth!.userId });
    res.json({ success: true, data: { condition } });
  } catch (err) {
    next(err);
  }
});

// The seller can't fulfil their part: cancel it (anything not yet shipped),
// refund the buyer for it, and charge the cancellation penalty once.
sellerOrdersRouter.post('/:orderId/cancel', async (req, res, next) => {
  try {
    const { reason, itemIds } = sellerOrderCancelSchema.parse(req.body);
    const result = await cancelSellerPart({
      orderId: req.params.orderId,
      sellerId: req.seller!.id,
      actorUserId: req.auth!.userId,
      reason,
      itemIds,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Bulk: the same transition across many lines, skipping the ones that can't.
sellerOrdersRouter.post('/bulk', async (req, res, next) => {
  try {
    const input = sellerOrderBulkSchema.parse(req.body);
    const where = { id: { in: input.itemIds }, sellerId: req.seller!.id };
    let items = await prisma.orderItem.findMany({ where, include: ACTION_INCLUDE });

    const found = new Set(items.map((i) => i.id));
    const skipped = input.itemIds
      .filter((id) => !found.has(id))
      .map((itemId) => ({ itemId, reason: 'Not one of your items' }));

    let updated = 0;
    if (input.action === 'assign') {
      const reasons = await bookLines(items, input.boxes);
      for (const item of items) {
        const reason = reasons.get(item.id);
        if (reason) skipped.push({ itemId: item.id, reason });
        else updated += 1;
      }
    } else {
      if (input.action === 'ship') {
        // Lines of one order shipped together go in one parcel: book the ones
        // not booked yet together, before each is shipped.
        const toBook: ItemForAction[] = [];
        for (const item of items) {
          if (bookingProblem(item) === null && (await hasPackingVideo(item.orderId, item.sellerId))) toBook.push(item);
        }
        const refused = await bookLines(toBook);
        for (const [itemId, reason] of refused) skipped.push({ itemId, reason });
        items = (await prisma.orderItem.findMany({ where, include: ACTION_INCLUDE })).filter((i) => !refused.has(i.id));
      }
      for (const item of items) {
        const reason = await applyAction(item, input.action);
        if (reason) skipped.push({ itemId: item.id, reason });
        else updated += 1;
      }
    }

    if (input.action === 'deliver' && updated > 0) {
      checkSellerReferralReward(req.seller!.id).catch((err) =>
        console.error('[clowe-api] referral reward check failed:', err),
      );
    }

    const body: SellerOrderBulkResult = { updated, skipped };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// What booking will cost: Delhivery's estimate, shown before the seller confirms
// ---------------------------------------------------------------------------

sellerOrdersRouter.get('/booking-quote', async (req, res, next) => {
  try {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (ids.length === 0) throw ApiError.badRequest('Select at least one item');
    res.json({ success: true, data: await bookingQuote(req.seller!, ids) });
  } catch (err) {
    next(err);
  }
});

// The same, for boxes the seller has corrected.
sellerOrdersRouter.post('/booking-quote', async (req, res, next) => {
  try {
    const input = sellerBookingQuoteSchema.parse(req.body);
    res.json({ success: true, data: await bookingQuote(req.seller!, input.itemIds, input.boxes) });
  } catch (err) {
    next(err);
  }
});

async function bookingQuote(
  seller: SellerProfile,
  ids: string[],
  boxes?: Record<string, ParcelBox>,
): Promise<SellerBookingQuote> {
  {
    const items = await prisma.orderItem.findMany({ where: { id: { in: ids }, sellerId: seller.id }, include: ACTION_INCLUDE });

    const found = new Set(items.map((i) => i.id));
    const skipped = ids.filter((id) => !found.has(id)).map((itemId) => ({ itemId, reason: 'Not one of your items' }));
    const byOrder = new Map<string, string[]>();
    for (const item of items) {
      const problem = bookingProblem(item);
      if (problem) skipped.push({ itemId: item.id, reason: problem });
      else byOrder.set(item.orderId, [...(byOrder.get(item.orderId) ?? []), item.id]);
    }

    const origin = pickupAddress(seller).pincode;
    const parcels: SellerBookingQuote['parcels'] = [];
    for (const [orderId, itemIds] of byOrder) {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: { include: { product: { select: { weightGrams: true, lengthMm: true, widthMm: true, heightMm: true } } } } },
      });
      const plan = { ...planParcel(order, order.items.filter((i) => itemIds.includes(i.id))), ...(boxes?.[orderId] ?? {}) };
      const chargeable = chargeableGrams(plan);
      let forward: number | null = null;
      let codFee: number | null = plan.isCod ? null : 0;
      let error: string | null = null;
      if (!origin) error = 'Add your pickup pincode in Store Settings to get an estimate';
      else {
        try {
          const route = { originPincode: origin, destinationPincode: order.shipPincode, mode: plan.mode, weightGrams: chargeable };
          forward = await forwardFreightPaise(route);
          if (plan.isCod) codFee = await codFeePaise(route, plan.codAmountPaise);
        } catch (err) {
          error = `No estimate from Delhivery right now${err instanceof Error ? ` (${err.message})` : ''}`;
        }
      }
      parcels.push({
        orderId,
        orderNumber: order.orderNumber,
        itemIds,
        payment: plan.isCod ? 'COD' : 'PREPAID',
        codAmountPaise: plan.codAmountPaise,
        weightGrams: plan.weightGrams,
        lengthMm: plan.lengthMm,
        widthMm: plan.widthMm,
        heightMm: plan.heightMm,
        chargeableGrams: chargeable,
        forwardFreightPaise: forward,
        codFeePaise: codFee,
        totalPaise: forward === null || codFee === null ? null : forward + codFee,
        error,
      });
    }
    return {
      parcels,
      skipped,
      totalPaise: parcels.reduce((sum, p) => sum + (p.totalPaise ?? 0), 0),
      provider: shippingProvider.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Shipping labels
// ---------------------------------------------------------------------------

sellerOrdersRouter.get('/labels', async (req, res, next) => {
  try {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (ids.length === 0) throw ApiError.badRequest('Select at least one item');

    const seller = req.seller!;
    const items = await prisma.orderItem.findMany({
      where: { id: { in: ids }, sellerId: seller.id },
      include: {
        order: { include: { items: { select: { id: true, pricePaise: true, quantity: true, promoDiscountPaise: true } } } },
        shipment: {
          include: { items: { select: { id: true, title: true, variantLabel: true, quantity: true, status: true } } },
        },
      },
    });
    items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

    // One label per parcel: every line in the box is on it, whichever were
    // picked. A line not booked yet gets its own, without an AWB.
    const groups = new Map<string, (typeof items)[number]>();
    for (const i of items) if (!groups.has(i.shipmentId ?? i.id)) groups.set(i.shipmentId ?? i.id, i);
    // Delhivery collects from the pickup address when one is set.
    const from = pickupAddress(seller);

    const labels: SellerShippingLabel[] = await Promise.all(
      [...groups].map(async ([key, i]) => {
        const shipment = i.shipment;
        const lines = shipment ? shipment.items : [i];
        const isCod = i.order.paymentMethod === 'COD';
        const slip = shipment?.awbNumber ? await shippingProvider.getLabel(shipment.awbNumber).catch(() => null) : null;
        return {
          key,
          orderItemIds: lines.map((l) => l.id),
          orderNumber: i.order.orderNumber,
          placedAt: i.order.createdAt.toISOString(),
          awbNumber: shipment?.awbNumber ?? i.awbNumber,
          courierName: i.courierName,
          sortCode: slip?.sortCode ?? null,
          destinationHub: slip?.destinationHub ?? null,
          mode: shipment?.mode ?? null,
          weightGrams: shipment?.weightGrams ?? null,
          isCod,
          codAmountPaise: !isCod
            ? 0
            : shipment
              ? shipment.codAmountPaise
              : valueOfLines(i.order.totalPaise, i.order.items, [i.id]),
          contents: lines.map((l) => ({ title: l.title, variantLabel: l.variantLabel, quantity: l.quantity, status: l.status })),
          shipTo: {
            name: i.order.shipName,
            line1: i.order.shipLine1,
            line2: i.order.shipLine2,
            city: i.order.shipCity,
            state: i.order.shipState,
            pincode: i.order.shipPincode,
          },
          shipFrom: {
            shopName: seller.pickupName || seller.shopName,
            ...from,
            gstNumber: seller.gstNumber,
          },
          // Delhivery's labels carry the return address: the seller's own
          // return address when they have one, else the ship-from above.
          returnTo: separateReturnAddress(seller).address,
          qr: await sellerOrderQr(i.orderId, { item: i.id }),
        };
      }),
    );
    res.json({ success: true, data: labels });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Tax invoice (seller's lines of one order)
// ---------------------------------------------------------------------------

sellerOrdersRouter.get('/:orderId/invoice', async (req, res, next) => {
  try {
    // The same invoice the buyer sees (services/taxInvoice), with the seller's QR.
    const invoice = await buildTaxInvoice(req.params.orderId, req.seller!.id);
    if (!invoice) throw ApiError.notFound('Order not found');
    const body: SellerInvoice = {
      ...invoice,
      qr: await sellerOrderQr(req.params.orderId, { invoice: invoice.invoiceNumber }),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// The credit notes reducing that invoice (returned, refunded lines): only this seller's.
sellerOrdersRouter.get('/:orderId/credit-notes', async (req, res, next) => {
  try {
    const body: CreditNote[] = await creditNotesFor(req.params.orderId, req.seller!.id);
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

sellerOrdersRouter.get('/export', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const query = listQuery.parse(req.query);
    const where = buildOrderWhere(sellerId, query);

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      include: ORDER_INCLUDE(sellerId),
    });

    const header = [
      'Order number',
      'Order date',
      'Customer',
      'City',
      'State',
      'Pincode',
      'Product',
      'Size',
      'Colour',
      'Qty',
      'Unit price (INR)',
      'Line total (INR)',
      'Item status',
      'Payment method',
      'Payment status',
      'Courier',
      'AWB',
    ];
    const lines = [header.join(',')];
    for (const order of orders) {
      const row = toRow(order);
      for (const line of row.lines) {
        lines.push(
          [
            row.orderNumber,
            row.placedAt,
            row.customer.name,
            row.shipTo.city,
            row.shipTo.state,
            row.shipTo.pincode,
            line.title,
            line.size,
            line.color,
            line.quantity,
            (line.pricePaise / 100).toFixed(2),
            ((line.pricePaise * line.quantity) / 100).toFixed(2),
            line.status,
            row.paymentMethod,
            row.paymentStatus,
            line.courierName ?? '',
            line.awbNumber ?? '',
          ]
            .map(csvCell)
            .join(','),
        );
      }
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clowe-orders.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Single order (detail page)
// ---------------------------------------------------------------------------

sellerOrdersRouter.get('/:orderId', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      include: ORDER_INCLUDE(sellerId),
    });
    if (!order || order.items.length === 0) throw ApiError.notFound('Order not found');
    const row = toRow(order, await dispatchContext(sellerId, [order.id]));
    res.json({ success: true, data: { ...row, packingVideo: await packingVideoView(order.id, sellerId) } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:orderId/packing-video — attach the clip (uploaded via /api/uploads/video)
// ---------------------------------------------------------------------------

sellerOrdersRouter.post('/:orderId/packing-video', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const { ref } = packingVideoAttachSchema.parse(req.body);
    const items = await prisma.orderItem.findMany({
      where: { orderId: req.params.orderId, sellerId },
      select: { status: true },
    });
    if (items.length === 0) throw ApiError.notFound('Order not found');
    // Once something has gone out, the clip is the record of what went: it
    // can be added if missing, never swapped.
    const existing = await prisma.orderPackingVideo.findUnique({
      where: { orderId_sellerId: { orderId: req.params.orderId, sellerId } },
    });
    const dispatched = items.some((i) => !['PLACED', 'CONFIRMED', 'PACKED', 'CANCELLED'].includes(i.status));
    if (existing && !existing.deletedAt && dispatched) {
      throw ApiError.badRequest('This order has shipped: its packing video can no longer be replaced', 'PACKING_VIDEO_LOCKED');
    }
    await assertOwnAssets([ref], { ownerId: req.auth!.userId, purpose: 'PACKING_VIDEO' });

    await prisma.orderPackingVideo.upsert({
      where: { orderId_sellerId: { orderId: req.params.orderId, sellerId } },
      create: { orderId: req.params.orderId, sellerId, fileRef: ref },
      update: { fileRef: ref, uploadedAt: new Date(), deletedAt: null },
    });
    // The clip it replaced is freed once the order points at the new one.
    if (existing && existing.fileRef !== ref && !existing.deletedAt) await removeStoredFile(existing.fileRef);
    res.json({ success: true, data: await packingVideoView(req.params.orderId, sellerId) });
  } catch (err) {
    next(err);
  }
});
