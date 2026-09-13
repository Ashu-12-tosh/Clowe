import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  gstRateFor,
  ADMIN_ORDER_SORTS,
  ADMIN_ORDER_STATUSES,
  ADMIN_ORDER_STATUS_LABELS,
  ADMIN_PAYMENT_STATUSES,
  ADMIN_PAYMENT_STATUS_LABELS,
  ORDER_CHANNELS,
  ORDER_TABS,
  ORDER_TAB_STATUSES,
  adminOrderCancelSchema,
  adminOrderNoteSchema,
  adminOrderStatusSchema,
  manualOrderImportSchema,
  manualOrderSchema,
  type AdminOrderCustomerHit,
  type AdminOrderDetail,
  type AdminOrderListRow,
  type AdminOrderStatus,
  type AdminOrdersPage,
  type AdminOrdersSummary,
  type AdminPaymentStatus,
  type ManualOrderImportResult,
  type OrderChannel,
  type OrderTab,
} from '@clowe/shared';
import { prisma } from '../db';
import { categoryRulesMap } from '../services/categoryRules';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import {
  displayPaymentStatus,
  settleCodIfDelivered,
  syncOrderStatus,
} from '../services/orderStatusService';
import { createManualOrder } from '../services/manualOrderService';
import { returnStock } from '../services/stockService';

export const adminOrdersRouter = Router();
adminOrdersRouter.use(requireAuth, requireRole('ADMIN'));

/** Orders scanned when the tab counts and charts are computed. */
const SCAN_CAP = 20000;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  tab: z.enum(ORDER_TABS).default('ALL'),
  status: z.enum(['ALL', ...ADMIN_ORDER_STATUSES]).default('ALL'),
  paymentStatus: z.enum(['ALL', ...ADMIN_PAYMENT_STATUSES]).default('ALL'),
  sellerId: z.string().trim().optional(),
  channel: z.enum(['ALL', ...ORDER_CHANNELS]).default('ALL'),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  minPaise: z.coerce.number().int().min(0).optional(),
  maxPaise: z.coerce.number().int().min(0).optional(),
  sort: z.enum(ADMIN_ORDER_SORTS).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(10),
});

type ListQuery = z.infer<typeof listQuery>;

const LIST_INCLUDE = {
  user: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true } },
  payment: { select: { status: true } },
  items: {
    select: {
      seller: { select: { shopName: true } },
      product: {
        select: { images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } } },
      },
    },
  },
} satisfies Prisma.OrderInclude;

type OrderRecord = Prisma.OrderGetPayload<{ include: typeof LIST_INCLUDE }>;

function channelOf(order: { placedByAdminId: string | null }): OrderChannel {
  return order.placedByAdminId ? 'ADMIN' : 'WEB';
}

function toListRow(order: OrderRecord): AdminOrderListRow {
  const paymentStatus = displayPaymentStatus(
    order.paymentMethod,
    order.payment?.status,
  ) as AdminPaymentStatus;
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customer: {
      id: order.user.id,
      name: order.user.name,
      email: order.user.email,
      phone: order.user.phone,
      avatarUrl: order.user.avatarUrl,
    },
    itemCount: order.items.length,
    itemThumbnails: order.items
      .map((i) => i.product.images[0]?.url)
      .filter((url): url is string => Boolean(url))
      .slice(0, 3),
    totalPaise: order.totalPaise,
    paymentStatus,
    paymentStatusLabel: ADMIN_PAYMENT_STATUS_LABELS[paymentStatus] ?? paymentStatus,
    paymentMethod: order.paymentMethod,
    status: order.status as AdminOrderStatus,
    statusLabel: ADMIN_ORDER_STATUS_LABELS[order.status as AdminOrderStatus] ?? order.status,
    sellerNames: [...new Set(order.items.map((i) => i.seller.shopName))],
    channel: channelOf(order),
    createdAt: order.createdAt.toISOString(),
  };
}

/**
 * Everything Postgres can filter. The payment-status filter is applied after
 * loading because COD_PENDING is a display state, not a stored one.
 */
function listWhere(query: ListQuery, ignoreTab = false): Prisma.OrderWhereInput {
  const tabStatuses = ignoreTab ? [] : ORDER_TAB_STATUSES[query.tab];
  return {
    ...(tabStatuses.length > 0
      ? { status: { in: tabStatuses as Prisma.OrderWhereInput['status'][] as never } }
      : {}),
    ...(query.status === 'ALL' ? {} : { status: query.status }),
    ...(query.sellerId ? { items: { some: { sellerId: query.sellerId } } } : {}),
    ...(query.channel === 'ALL'
      ? {}
      : query.channel === 'ADMIN'
        ? { placedByAdminId: { not: null } }
        : { placedByAdminId: null }),
    ...(query.minPaise !== undefined || query.maxPaise !== undefined
      ? {
          totalPaise: {
            ...(query.minPaise !== undefined ? { gte: query.minPaise } : {}),
            ...(query.maxPaise !== undefined ? { lte: query.maxPaise } : {}),
          },
        }
      : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { orderNumber: { contains: query.q, mode: 'insensitive' } },
            { user: { name: { contains: query.q, mode: 'insensitive' } } },
            { user: { email: { contains: query.q, mode: 'insensitive' } } },
            { user: { phone: { contains: query.q } } },
            { shipName: { contains: query.q, mode: 'insensitive' } },
            { shipPhone: { contains: query.q } },
          ],
        }
      : {}),
  };
}

function sortRows(rows: AdminOrderListRow[], sort: ListQuery['sort']): AdminOrderListRow[] {
  const ranked = [...rows];
  ranked.sort((a, b) => {
    switch (sort) {
      case 'OLDEST':
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      case 'AMOUNT_HIGH':
        return b.totalPaise - a.totalPaise;
      case 'AMOUNT_LOW':
        return a.totalPaise - b.totalPaise;
      case 'STATUS':
        return a.status.localeCompare(b.status);
      default:
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
  });
  return ranked;
}

adminOrdersRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);

    // Load once with the tab ignored, so the tab badges can be counted from the
    // same filtered set the table is drawn from.
    const orders = await prisma.order.findMany({
      where: listWhere(query, true),
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      include: LIST_INCLUDE,
    });

    const all = orders
      .map(toListRow)
      .filter((row) => query.paymentStatus === 'ALL' || row.paymentStatus === query.paymentStatus);

    const tabCounts = Object.fromEntries(
      ORDER_TABS.map((tab) => [
        tab,
        tab === 'ALL'
          ? all.length
          : all.filter((row) => ORDER_TAB_STATUSES[tab].includes(row.status)).length,
      ]),
    ) as Record<OrderTab, number>;

    const filtered =
      query.tab === 'ALL'
        ? all
        : all.filter((row) => ORDER_TAB_STATUSES[query.tab].includes(row.status));
    const sorted = sortRows(filtered, query.sort);
    const start = (query.page - 1) * query.pageSize;

    const body: AdminOrdersPage = {
      rows: sorted.slice(start, start + query.pageSize),
      total: sorted.length,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(sorted.length / query.pageSize)),
      tabCounts,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Summary — KPIs and the charts under the table
// ---------------------------------------------------------------------------

const summaryQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

adminOrdersRouter.get('/summary', async (req, res, next) => {
  try {
    const { days } = summaryQuery.parse(req.query);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(startOfToday.getTime() - (days - 1) * 86400000);
    const previousFrom = new Date(from.getTime() - days * 86400000);

    const [orders, previous, sellerLines] = await Promise.all([
      prisma.order.findMany({
        where: { createdAt: { gte: from } },
        select: {
          id: true,
          status: true,
          totalPaise: true,
          paymentMethod: true,
          createdAt: true,
          payment: { select: { status: true } },
        },
        take: SCAN_CAP,
      }),
      prisma.order.findMany({
        where: { createdAt: { gte: previousFrom, lt: from } },
        select: { totalPaise: true, status: true },
        take: SCAN_CAP,
      }),
      prisma.orderItem.findMany({
        where: {
          order: { createdAt: { gte: from } },
          status: { notIn: ['CANCELLED', 'RETURNED'] },
        },
        select: {
          orderId: true,
          quantity: true,
          pricePaise: true,
          sellerId: true,
          seller: { select: { shopName: true } },
        },
        take: SCAN_CAP,
      }),
    ]);

    const counts = new Map<string, number>();
    for (const o of orders) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);

    // Revenue counts orders that were not cancelled or returned — the same rule
    // the marketplace overview uses, so the two dashboards agree.
    const live = orders.filter((o) => !['CANCELLED', 'RETURNED'].includes(o.status));
    const revenuePaise = live.reduce((sum, o) => sum + o.totalPaise, 0);
    const aov = live.length > 0 ? Math.round(revenuePaise / live.length) : 0;

    const previousLive = previous.filter((o) => !['CANCELLED', 'RETURNED'].includes(o.status));
    const previousRevenue = previousLive.reduce((sum, o) => sum + o.totalPaise, 0);
    const previousAov =
      previousLive.length > 0 ? Math.round(previousRevenue / previousLive.length) : 0;

    const change = (value: number, before: number) =>
      before > 0 ? Math.round(((value - before) / before) * 1000) / 10 : null;

    // --- Trend -----------------------------------------------------------
    const trend = new Map<string, { orders: number; revenuePaise: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      trend.set(dayKey(new Date(startOfToday.getTime() - i * 86400000)), {
        orders: 0,
        revenuePaise: 0,
      });
    }
    for (const o of orders) {
      const bucket = trend.get(dayKey(o.createdAt));
      if (!bucket) continue;
      bucket.orders += 1;
      if (!['CANCELLED', 'RETURNED'].includes(o.status)) bucket.revenuePaise += o.totalPaise;
    }

    // --- Payment split ---------------------------------------------------
    const paymentCounts = new Map<string, number>();
    for (const o of orders) {
      const key = displayPaymentStatus(o.paymentMethod, o.payment?.status);
      paymentCounts.set(key, (paymentCounts.get(key) ?? 0) + 1);
    }

    // --- Top sellers -----------------------------------------------------
    const bySeller = new Map<string, { name: string; orders: Set<string>; revenuePaise: number }>();
    for (const line of sellerLines) {
      const entry = bySeller.get(line.sellerId) ?? {
        name: line.seller.shopName,
        orders: new Set<string>(),
        revenuePaise: 0,
      };
      entry.orders.add(line.orderId);
      entry.revenuePaise += line.pricePaise * line.quantity;
      bySeller.set(line.sellerId, entry);
    }

    const total = orders.length || 1;
    const body: AdminOrdersSummary = {
      kpis: {
        total: { value: orders.length, changePercent: change(orders.length, previous.length) },
        pending: counts.get('PLACED') ?? 0,
        processing: (counts.get('CONFIRMED') ?? 0) + (counts.get('PACKED') ?? 0),
        shipped: counts.get('SHIPPED') ?? 0,
        delivered: counts.get('DELIVERED') ?? 0,
        returned: (counts.get('RETURNED') ?? 0) + (counts.get('RETURN_REQUESTED') ?? 0),
        cancelled: counts.get('CANCELLED') ?? 0,
        revenuePaise,
        averageOrderValuePaise: aov,
        averageOrderValueChangePercent: change(aov, previousAov),
      },
      trend: [...trend.entries()].map(([date, v]) => ({
        date,
        orders: v.orders,
        revenuePaise: v.revenuePaise,
      })),
      statusDistribution: ADMIN_ORDER_STATUSES.map((key) => {
        const count = counts.get(key) ?? 0;
        return {
          key,
          label: ADMIN_ORDER_STATUS_LABELS[key],
          count,
          share: Math.round((count / total) * 1000) / 10,
        };
      }).filter((s) => s.count > 0),
      paymentDistribution: ADMIN_PAYMENT_STATUSES.map((key) => {
        const count = paymentCounts.get(key) ?? 0;
        return {
          key,
          label: ADMIN_PAYMENT_STATUS_LABELS[key],
          count,
          share: Math.round((count / total) * 1000) / 10,
        };
      }).filter((s) => s.count > 0),
      topSellers: [...bySeller.entries()]
        .map(([id, s]) => ({
          id,
          name: s.name,
          orders: s.orders.size,
          revenuePaise: s.revenuePaise,
        }))
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 5),
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Detail — the drawer
// ---------------------------------------------------------------------------

adminOrdersRouter.get('/:id', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true } },
        payment: true,
        placedByAdmin: { select: { name: true } },
        refunds: { select: { amountPaise: true, status: true } },
        complaints: { select: { id: true, complaintId: true, subject: true, status: true } },
        items: {
          include: {
            seller: { select: { id: true, shopName: true } },
            variant: { select: { sku: true } },
            return: { select: { status: true } },
            product: {
              select: {
                taxRatePercent: true,
                categoryId: true,
                images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
              },
            },
          },
        },
      },
    });
    if (!order) throw ApiError.notFound('Order not found');

    const [orderCount, lifetime] = await Promise.all([
      prisma.order.count({ where: { userId: order.userId } }),
      prisma.order.aggregate({
        where: { userId: order.userId, status: { notIn: ['CANCELLED', 'RETURNED'] } },
        _sum: { totalPaise: true },
      }),
    ]);

    const paymentStatus = displayPaymentStatus(
      order.paymentMethod,
      order.payment?.status,
    ) as AdminPaymentStatus;

    // GST is already inside the prices the shopper paid, so this is the tax
    // component of the item total, not something added on top. Rates are
    // per-listing with the category rule as the fallback - the same rule the
    // seller invoice uses.
    const taxRules = await categoryRulesMap(order.items.map((i) => i.product.categoryId));
    const taxPaise = order.items.reduce((sum, i) => {
      const gross = i.pricePaise * i.quantity;
      const rate = gstRateFor(i.pricePaise, i.product.taxRatePercent, taxRules.get(i.product.categoryId)!);
      return sum + (gross - Math.round(gross / (1 + rate / 100)));
    }, 0);

    const body: AdminOrderDetail = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status as AdminOrderStatus,
      statusLabel: ADMIN_ORDER_STATUS_LABELS[order.status as AdminOrderStatus] ?? order.status,
      channel: channelOf(order),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      placedByAdminName: order.placedByAdmin?.name ?? null,
      adminNote: order.adminNote,

      customer: {
        id: order.user.id,
        name: order.user.name,
        email: order.user.email,
        phone: order.user.phone,
        avatarUrl: order.user.avatarUrl,
        orderCount,
        lifetimeValuePaise: lifetime._sum.totalPaise ?? 0,
      },

      shipping: {
        name: order.shipName,
        phone: order.shipPhone,
        line1: order.shipLine1,
        line2: order.shipLine2,
        city: order.shipCity,
        state: order.shipState,
        pincode: order.shipPincode,
        method: order.deliveryMethod,
        etaFrom: order.etaFrom?.toISOString() ?? null,
        etaTo: order.etaTo?.toISOString() ?? null,
      },

      summary: {
        itemsTotalPaise: order.subtotalPaise,
        shippingPaise: order.shippingPaise,
        discountPaise: order.discountPaise,
        couponCode: order.couponCode,
        couponDiscountPaise: order.couponDiscountPaise,
        creditsUsed: order.creditsUsed,
        taxPaise,
        totalPaise: order.totalPaise,
      },

      payment: {
        method: order.paymentMethod,
        status: paymentStatus,
        statusLabel: ADMIN_PAYMENT_STATUS_LABELS[paymentStatus] ?? paymentStatus,
        provider: order.payment?.provider ?? null,
        providerOrderId: order.payment?.providerOrderId ?? null,
        providerPaymentId: order.payment?.providerPaymentId ?? null,
        paidAt: order.payment?.status === 'PAID' ? order.payment.updatedAt.toISOString() : null,
        failureReason: order.payment?.failureReason ?? null,
        refundedPaise: order.refunds
          .filter((r) => r.status === 'PROCESSED')
          .reduce((sum, r) => sum + r.amountPaise, 0),
      },

      items: order.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        variantId: i.variantId,
        title: i.title,
        imageUrl: i.product.images[0]?.url ?? null,
        size: i.size,
        color: i.color,
        variantLabel: i.variantLabel,
        sku: i.variant.sku,
        sellerId: i.seller.id,
        sellerName: i.seller.shopName,
        quantity: i.quantity,
        pricePaise: i.pricePaise,
        status: i.status as AdminOrderStatus,
        statusLabel: ADMIN_ORDER_STATUS_LABELS[i.status as AdminOrderStatus] ?? i.status,
        trackingNumber: i.awbNumber,
        courier: i.courierName,
        returnStatus: i.return?.status ?? null,
      })),
      isGift: order.isGift,
      giftMessage: order.giftMessage,
      complaints: order.complaints.map((c) => ({
        id: c.id,
        reference: c.complaintId,
        subject: c.subject ?? 'Support ticket',
        status: c.status,
      })),
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Status — an admin override on top of what the seller does
// ---------------------------------------------------------------------------

const FORWARD: Record<string, number> = {
  PLACED: 0,
  CONFIRMED: 1,
  PACKED: 2,
  SHIPPED: 3,
  DELIVERED: 4,
};

adminOrdersRouter.patch('/:id/status', async (req, res, next) => {
  try {
    const input = adminOrderStatusSchema.parse(req.body);
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!order) throw ApiError.notFound('Order not found');

    const targets = input.itemId
      ? order.items.filter((i) => i.id === input.itemId)
      : order.items.filter(
          (i) => !['CANCELLED', 'RETURNED', 'RETURN_REQUESTED'].includes(i.status),
        );
    if (targets.length === 0) throw ApiError.badRequest('Nothing on this order can be moved');

    // Fulfilment only ever runs forwards. Undoing a delivery would silently
    // unpick a payout, so that has to be a refund or a return, not a status flip.
    for (const item of targets) {
      const current = FORWARD[item.status];
      if (current === undefined) {
        throw ApiError.badRequest(
          `"${item.title}" is ${item.status.toLowerCase()} and cannot move`,
        );
      }
      if (FORWARD[input.status]! <= current) {
        throw ApiError.badRequest(
          `"${item.title}" is already at ${ADMIN_ORDER_STATUS_LABELS[item.status as AdminOrderStatus]} — use a return or refund to go back`,
          'BACKWARDS_STATUS',
        );
      }
    }

    await prisma.orderItem.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: {
        status: input.status,
        ...(input.trackingNumber ? { awbNumber: input.trackingNumber } : {}),
        ...(input.courier ? { courierName: input.courier } : {}),
        ...(input.status === 'SHIPPED' ? { shippedAt: new Date() } : {}),
        ...(input.status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
      },
    });
    if (input.note) {
      await prisma.order.update({
        where: { id: order.id },
        data: { adminNote: input.note },
      });
    }

    await syncOrderStatus(order.id);
    await settleCodIfDelivered(order.id);

    await prisma.notification.create({
      data: {
        userId: order.userId,
        type: 'ORDER_UPDATE',
        title: `Order ${order.orderNumber} updated`,
        body: `Your order is now ${ADMIN_ORDER_STATUS_LABELS[input.status].toLowerCase()}.`,
        linkHref: `/account/orders/${order.id}`,
      },
    });

    res.json({ success: true, data: { id: order.id, moved: targets.length } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

adminOrdersRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const input = adminOrderCancelSchema.parse(req.body);
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true, payment: true },
    });
    if (!order) throw ApiError.notFound('Order not found');
    if (order.status === 'CANCELLED') throw ApiError.badRequest('Order is already cancelled');

    const live = order.items.filter(
      (i) => !['CANCELLED', 'RETURNED', 'RETURN_REQUESTED'].includes(i.status),
    );
    if (live.some((i) => i.status === 'DELIVERED')) {
      throw ApiError.badRequest(
        'Delivered items cannot be cancelled — raise a return instead',
        'ALREADY_DELIVERED',
      );
    }
    if (live.length === 0) throw ApiError.badRequest('Nothing on this order can be cancelled');

    await prisma.$transaction([
      prisma.orderItem.updateMany({
        where: { id: { in: live.map((i) => i.id) } },
        data: { status: 'CANCELLED' },
      }),
      prisma.order.update({
        where: { id: order.id },
        data: { adminNote: `Cancelled by admin: ${input.reason}` },
      }),
      // Reserved units go back on the variant; the ledger entry follows below.
      ...live.map((item) =>
        prisma.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { increment: item.quantity } },
        }),
      ),
      // A cancelled order releases its coupon redemption and its credits.
      ...(order.couponCode && order.couponDiscountPaise > 0
        ? [
            prisma.coupon.updateMany({
              where: { code: order.couponCode, usedCount: { gt: 0 } },
              data: { usedCount: { decrement: 1 } },
            }),
          ]
        : []),
      ...(order.creditsUsed > 0
        ? [
            prisma.user.update({
              where: { id: order.userId },
              data: { creditsBalance: { increment: order.creditsUsed } },
            }),
          ]
        : []),
      ...(order.payment && order.payment.status === 'PAID'
        ? [
            prisma.payment.update({
              where: { id: order.payment.id },
              data: { status: 'REFUNDED' },
            }),
          ]
        : []),
    ]);

    await prisma.$transaction(async (tx) => {
      for (const item of live) {
        await returnStock(tx, {
          variantId: item.variantId,
          quantity: item.quantity,
          reason: `Cancelled by admin: ${input.reason}`,
          reference: order.orderNumber,
          actorId: req.auth!.userId,
        });
      }
    });

    await syncOrderStatus(order.id);
    await prisma.notification.create({
      data: {
        userId: order.userId,
        type: 'ORDER_CANCELLED',
        title: `Order ${order.orderNumber} cancelled`,
        body: input.reason,
        linkHref: `/account/orders/${order.id}`,
      },
    });

    res.json({ success: true, data: { cancelled: live.length } });
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.patch('/:id/note', async (req, res, next) => {
  try {
    const input = adminOrderNoteSchema.parse(req.body);
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Order not found');
    await prisma.order.update({
      where: { id: order.id },
      data: { adminNote: input.adminNote || null },
    });
    res.json({ success: true, data: { id: order.id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Manual orders — placed by an admin for a shopper (phone orders)
// ---------------------------------------------------------------------------

adminOrdersRouter.post('/manual', async (req, res, next) => {
  try {
    const input = manualOrderSchema.parse(req.body);
    const created = await createManualOrder({
      userId: input.userId,
      addressId: input.addressId,
      paymentMethod: input.paymentMethod,
      deliveryMethod: input.deliveryMethod,
      adminNote: input.adminNote || undefined,
      adminId: req.auth!.userId,
      items: input.items,
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

/**
 * Bulk phone orders from a sheet. Each row becomes a real order through the
 * same path as a single manual order — stock is reserved and sellers are paid.
 * This is NOT a historical migration: importing an order that already shipped
 * elsewhere would double-count GMV and take stock that was never there.
 */
adminOrdersRouter.post('/manual/import', async (req, res, next) => {
  try {
    const input = manualOrderImportSchema.parse(req.body);

    const [users, variants] = await Promise.all([
      prisma.user.findMany({
        where: { phone: { in: [...new Set(input.rows.map((r) => r.phone))] } },
        select: {
          id: true,
          phone: true,
          addresses: { orderBy: { createdAt: 'asc' }, select: { id: true } },
        },
      }),
      prisma.productVariant.findMany({
        where: { sku: { in: [...new Set(input.rows.map((r) => r.sku))] } },
        select: { id: true, sku: true },
      }),
    ]);
    const userByPhone = new Map(users.map((u) => [u.phone, u]));
    const variantBySku = new Map(variants.map((v) => [v.sku.toUpperCase(), v.id]));

    const created: ManualOrderImportResult['created'] = [];
    const skipped: ManualOrderImportResult['skipped'] = [];

    for (const [index, row] of input.rows.entries()) {
      const rowNumber = index + 1;
      const user = userByPhone.get(row.phone);
      if (!user) {
        skipped.push({ row: rowNumber, phone: row.phone, reason: 'No customer with that phone' });
        continue;
      }
      const addressId = user.addresses[0]?.id;
      if (!addressId) {
        skipped.push({
          row: rowNumber,
          phone: row.phone,
          reason: 'That customer has no saved address',
        });
        continue;
      }
      const variantId = variantBySku.get(row.sku.toUpperCase());
      if (!variantId) {
        skipped.push({
          row: rowNumber,
          phone: row.phone,
          reason: `No variant with SKU ${row.sku}`,
        });
        continue;
      }

      try {
        const order = await createManualOrder({
          userId: user.id,
          addressId,
          paymentMethod: row.paymentMethod,
          deliveryMethod: 'STANDARD',
          adminNote: row.note,
          adminId: req.auth!.userId,
          items: [{ variantId, quantity: row.quantity }],
        });
        created.push({
          orderNumber: order.orderNumber,
          phone: row.phone,
          totalPaise: order.totalPaise,
        });
      } catch (err) {
        skipped.push({
          row: rowNumber,
          phone: row.phone,
          reason: err instanceof ApiError ? err.message : 'Could not place that order',
        });
      }
    }

    const body: ManualOrderImportResult = { created, skipped };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Meta + export
// ---------------------------------------------------------------------------

adminOrdersRouter.get('/meta/options', async (_req, res, next) => {
  try {
    const sellers = await prisma.sellerProfile.findMany({
      orderBy: { shopName: 'asc' },
      select: { id: true, shopName: true },
    });
    res.json({
      success: true,
      data: { sellers: sellers.map((s) => ({ id: s.id, name: s.shopName })) },
    });
  } catch (err) {
    next(err);
  }
});

/** Customer lookup for the Create Order form. */
adminOrdersRouter.get('/meta/customers', async (req, res, next) => {
  try {
    const { q } = z.object({ q: z.string().trim().min(2).max(80) }).parse(req.query);
    const users = await prisma.user.findMany({
      where: {
        role: 'CUSTOMER',
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
        ],
      },
      take: 10,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        addresses: { orderBy: { createdAt: 'asc' } },
      },
    });

    const hits: AdminOrderCustomerHit[] = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      addresses: u.addresses.map((a) => ({
        id: a.id,
        label: a.label,
        name: a.name,
        phone: a.phone,
        line1: a.line1,
        line2: a.line2,
        city: a.city,
        state: a.state,
        pincode: a.pincode,
      })),
    }));
    res.json({ success: true, data: hits });
  } catch (err) {
    next(err);
  }
});

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

adminOrdersRouter.get('/meta/export', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const orders = await prisma.order.findMany({
      where: listWhere(query, true),
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      include: LIST_INCLUDE,
    });

    const rows = sortRows(
      orders
        .map(toListRow)
        .filter((r) => query.paymentStatus === 'ALL' || r.paymentStatus === query.paymentStatus)
        .filter((r) => query.tab === 'ALL' || ORDER_TAB_STATUSES[query.tab].includes(r.status)),
      query.sort,
    );

    const header = [
      'Order',
      'Placed',
      'Customer',
      'Email',
      'Phone',
      'Items',
      'Sellers',
      'Amount (₹)',
      'Payment method',
      'Payment status',
      'Status',
      'Channel',
    ].join(',');
    const body = rows
      .map((r) =>
        [
          r.orderNumber,
          r.createdAt,
          r.customer.name ?? '',
          r.customer.email ?? '',
          r.customer.phone,
          r.itemCount,
          r.sellerNames.join(' | '),
          (r.totalPaise / 100).toFixed(2),
          r.paymentMethod,
          r.paymentStatusLabel,
          r.statusLabel,
          r.channel,
        ]
          .map(csvCell)
          .join(','),
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(`${header}\n${body}`);
  } catch (err) {
    next(err);
  }
});
