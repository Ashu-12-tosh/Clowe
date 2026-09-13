import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  gstRateFor,
  SELLER_ORDER_TABS,
  SELLER_ORDER_TAB_LABELS,
  SELLER_ORDER_TAB_STATUSES,
  SELLER_ORDER_SORTS,
  SELLER_PAYMENT_FILTERS,
  sellerOrderActionSchema,
  sellerOrderBulkSchema,
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
} from '@clowe/shared';
import QRCode from 'qrcode';
import { prisma } from '../db';
import { categoryRulesMap } from '../services/categoryRules';
import { webPublicUrl } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { shippingProvider } from '../services/shipping';
import { sendMessageSafe } from '../services/messaging';
import { checkSellerReferralReward } from '../services/sellerReferralService';
import { requireSeller } from './seller';
import {
  aggregateStatus,
  settleCodIfDelivered,
  syncOrderStatus,
} from '../services/orderStatusService';

export const sellerOrdersRouter = Router();
sellerOrdersRouter.use(requireAuth, requireSeller);

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
    user: { select: { name: true } },
    payment: { select: { status: true } },
    items: {
      where: { sellerId },
      include: {
        product: { select: { slug: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
        return: { select: { id: true, status: true } },
      },
    },
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
    packedAt: item.packedAt?.toISOString() ?? null,
    shippedAt: item.shippedAt?.toISOString() ?? null,
    deliveredAt: item.deliveredAt?.toISOString() ?? null,
    returnId: item.return?.id ?? null,
    returnStatus: item.return?.status ?? null,
    canPack: !orderCancelled && item.status === 'CONFIRMED',
    canShip: !orderCancelled && (item.status === 'CONFIRMED' || item.status === 'PACKED'),
    canDeliver: !orderCancelled && item.status === 'SHIPPED',
  };
}

function toRow(order: OrderRecord): SellerOrderRow {
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

    // findMany doesn't preserve `in` order — restore the ranking.
    const byId = new Map(orders.map((o) => [o.id, o]));
    const rows = pageIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((o) => toRow(o!));

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
// GET /summary — KPI tiles, shop overview, couriers, refund requests
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
        courierName: true,
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
    const sold = items.filter((i) => !['CANCELLED', 'RETURNED'].includes(i.status));
    const totalSalesPaise = sold.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
    const totalOrders = new Set(items.map((i) => i.orderId)).size;
    const units = items.reduce((sum, i) => sum + i.quantity, 0);
    const returnedUnits = items
      .filter((i) => ['RETURNED', 'RETURN_REQUESTED'].includes(i.status))
      .reduce((sum, i) => sum + i.quantity, 0);
    const cancelledUnits = items
      .filter((i) => i.status === 'CANCELLED')
      .reduce((sum, i) => sum + i.quantity, 0);

    const shipped = items.filter((i) => i.courierName);
    const courierCounts = new Map<string, number>();
    for (const i of shipped) {
      courierCounts.set(i.courierName!, (courierCounts.get(i.courierName!) ?? 0) + 1);
    }

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
      topCouriers: [...courierCounts.entries()]
        .map(([courier, count]) => ({
          courier,
          count,
          share: shipped.length > 0 ? Math.round((count / shipped.length) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      recentRefunds: returns.map((r) => ({
        returnId: r.id,
        orderItemId: r.orderItemId,
        orderNumber: r.orderItem.order.orderNumber,
        title: r.orderItem.title,
        amountPaise: r.orderItem.pricePaise * r.orderItem.quantity,
        status: r.status,
        requestedAt: r.createdAt.toISOString(),
      })),
      couriers: [...shippingProvider.couriers],
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

/**
 * Moves one line to the next stage. Returns null on success or the reason it
 * was skipped — bulk uses the reason, single-item raises it as an error.
 */
async function applyAction(
  item: ItemForAction,
  action: Action,
  courier: string | undefined,
): Promise<string | null> {
  if (item.order.status === 'CANCELLED') return 'Order was cancelled';

  if (action === 'pack') {
    if (item.status !== 'CONFIRMED') return `Cannot pack an item in status ${item.status}`;
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
    // Packing is optional — a seller can ship straight from a new order.
    if (item.status !== 'CONFIRMED' && item.status !== 'PACKED') {
      return `Cannot ship an item in status ${item.status}`;
    }
    const shipment = await shippingProvider.createShipment({
      orderNumber: item.order.orderNumber,
      orderItemId: item.id,
      destinationCity: item.order.shipCity,
      destinationPincode: item.order.shipPincode,
      preferredCourier: courier,
    });
    await prisma.$transaction([
      prisma.orderItem.update({
        where: { id: item.id },
        data: {
          status: 'SHIPPED',
          shippedAt: new Date(),
          awbNumber: shipment.awbNumber,
          courierName: shipment.courierName,
          trackingUrl: shipment.trackingUrl,
        },
      }),
      prisma.notification.create({
        data: {
          userId: item.order.user.id,
          type: 'ITEM_SHIPPED',
          title: 'Your order is on its way 🚚',
          body: `"${item.title}" (${item.order.orderNumber}) shipped via ${shipment.courierName} — AWB ${shipment.awbNumber}. Expected in ~${shipment.etaDays} days.`,
          linkHref: `/account/orders/${item.orderId}`,
        },
      }),
    ]);
    sendMessageSafe({
      channel: 'whatsapp',
      to: `+91${item.order.user.phone}`,
      body: `Your Clowe item "${item.title}" has shipped via ${shipment.courierName} (AWB ${shipment.awbNumber}). Track: /track 🚚`,
    });
    await syncOrderStatus(item.orderId);
    return null;
  }

  if (item.status !== 'SHIPPED') return `Cannot deliver an item in status ${item.status}`;
  await prisma.$transaction([
    prisma.orderItem.update({
      where: { id: item.id },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    }),
    prisma.notification.create({
      data: {
        userId: item.order.user.id,
        type: 'ITEM_DELIVERED',
        title: 'Delivered! 📦',
        body: `"${item.title}" (${item.order.orderNumber}) has been delivered. We'd love a review!`,
        linkHref: `/account/orders/${item.orderId}`,
      },
    }),
  ]);
  await syncOrderStatus(item.orderId);
  await settleCodIfDelivered(item.orderId);
  return null;
}

// Single line: pack / ship / deliver.
sellerOrdersRouter.patch('/:itemId/status', async (req, res, next) => {
  try {
    const input = sellerOrderActionSchema.parse(req.body);
    const item = await prisma.orderItem.findUnique({
      where: { id: req.params.itemId },
      include: { order: { include: { user: { select: { id: true, phone: true } } } } },
    });
    if (!item || item.sellerId !== req.seller!.id) throw ApiError.notFound('Order item not found');

    const skipped = await applyAction(item, input.action, input.courier);
    if (skipped) throw ApiError.badRequest(skipped);

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

// Bulk: the same transition across many lines, skipping the ones that can't.
sellerOrdersRouter.post('/bulk', async (req, res, next) => {
  try {
    const input = sellerOrderBulkSchema.parse(req.body);
    const items = await prisma.orderItem.findMany({
      where: { id: { in: input.itemIds }, sellerId: req.seller!.id },
      include: { order: { include: { user: { select: { id: true, phone: true } } } } },
    });

    const found = new Set(items.map((i) => i.id));
    const skipped = input.itemIds
      .filter((id) => !found.has(id))
      .map((itemId) => ({ itemId, reason: 'Not one of your items' }));

    let updated = 0;
    for (const item of items) {
      const reason = await applyAction(item, input.action, input.courier);
      if (reason) skipped.push({ itemId: item.id, reason });
      else updated += 1;
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
      include: { order: true },
    });

    const labels: SellerShippingLabel[] = await Promise.all(
      items.map(async (i) => ({
      orderItemId: i.id,
      orderNumber: i.order.orderNumber,
      placedAt: i.order.createdAt.toISOString(),
      awbNumber: i.awbNumber,
      courierName: i.courierName,
      status: i.status,
      isCod: i.order.paymentMethod === 'COD',
      codAmountPaise: i.order.paymentMethod === 'COD' ? i.pricePaise * i.quantity : 0,
      title: i.title,
      size: i.size,
      color: i.color,
      variantLabel: i.variantLabel,
      quantity: i.quantity,
      shipTo: {
        name: i.order.shipName,
        line1: i.order.shipLine1,
        line2: i.order.shipLine2,
        city: i.order.shipCity,
        state: i.order.shipState,
        pincode: i.order.shipPincode,
      },
      // Couriers collect from the pickup address when one is set.
      shipFrom: {
        shopName: seller.pickupName || seller.shopName,
        line1: seller.pickupSameAsBusiness ? seller.addressLine1 : seller.pickupLine1,
        city: seller.pickupSameAsBusiness ? seller.city : seller.pickupCity,
        state: seller.pickupSameAsBusiness ? seller.state : seller.pickupState,
        pincode: seller.pickupSameAsBusiness ? seller.pincode : seller.pickupPincode,
        gstNumber: seller.gstNumber,
      },
      qr: await sellerOrderQr(i.orderId, { item: i.id }),
      })),
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
    const seller = req.seller!;
    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      include: {
        user: { select: { name: true } },
        payment: { select: { status: true } },
        items: {
          where: { sellerId: seller.id },
          include: { product: { select: { taxRatePercent: true, categoryId: true } } },
        },
      },
    });
    if (!order || order.items.length === 0) throw ApiError.notFound('Order not found');
    if (order.status === 'PLACED') throw ApiError.badRequest('This order is not paid yet');
    // GST: the listing's own slab, else the category rule (apparel slab, flat 18%, 0% for books...).
    const taxRules = await categoryRulesMap(order.items.map((i) => i.product.categoryId));

    const lines = order.items.map((i) => {
      const gross = i.pricePaise * i.quantity;
      const rate = gstRateFor(i.pricePaise, i.product.taxRatePercent, taxRules.get(i.product.categoryId)!);
      const taxable = Math.round(gross / (1 + rate / 100));
      return {
        title: i.title,
        size: i.size,
        color: i.color,
        variantLabel: i.variantLabel,
        quantity: i.quantity,
        unitPricePaise: i.pricePaise,
        grossPaise: gross,
        taxablePaise: taxable,
        gstPaise: gross - taxable,
      };
    });

    const taxablePaise = lines.reduce((sum, l) => sum + l.taxablePaise, 0);
    const gstPaise = lines.reduce((sum, l) => sum + l.gstPaise, 0);

    const invoiceNumber = `INV-${order.orderNumber}-${seller.id.slice(-4).toUpperCase()}`;
    const body: SellerInvoice = {
      invoiceNumber,
      issuedAt: new Date().toISOString(),
      orderNumber: order.orderNumber,
      placedAt: order.createdAt.toISOString(),
      paymentMethod: order.paymentMethod,
      paymentStatus:
        order.payment?.status ?? (order.paymentMethod === 'COD' ? 'COD_PENDING' : 'CREATED'),
      seller: {
        shopName: seller.shopName,
        line1: seller.addressLine1,
        city: seller.city,
        state: seller.state,
        pincode: seller.pincode,
        gstNumber: seller.gstNumber,
        panNumber: seller.panNumber,
      },
      billTo: {
        name: order.billName ?? order.shipName,
        line1: order.billLine1 ?? order.shipLine1,
        line2: order.billLine2 ?? order.shipLine2,
        city: order.billCity ?? order.shipCity,
        state: order.billState ?? order.shipState,
        pincode: order.billPincode ?? order.shipPincode,
      },
      customer: { name: order.user.name ?? order.shipName },
      lines,
      gstRatePercent:
        order.items.length > 0
          ? gstRateFor(
              order.items[0].pricePaise,
              order.items[0].product.taxRatePercent,
              taxRules.get(order.items[0].product.categoryId)!,
            )
          : 5,
      taxablePaise,
      gstPaise,
      isIntraState:
        !!seller.state && seller.state.toLowerCase() === (order.shipState ?? '').toLowerCase(),
      totalPaise: taxablePaise + gstPaise,
      qr: await sellerOrderQr(order.id, { invoice: invoiceNumber }),
    };
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
    res.json({ success: true, data: toRow(order) });
  } catch (err) {
    next(err);
  }
});
