import { Router } from 'express';
import {
  creditsToPaise,
  PAYMENT_METHOD_KINDS,
  savedPaymentMethodSchema,
  type PaymentMethodKind,
  type AccountOverview,
  type MyCoupon,
  type MyCouponsResponse,
  type MyCounts,
  RETURN_FILTERS,
  type MyReturnRow,
  type MyReturnsResponse,
  type ReturnFilter,
  type ProductListItem,
  type SavedPaymentMethodInfo,
} from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { productListItemInclude, toProductListItem } from '../utils/productListing';
import { toAddressInfo } from './addresses';

export const meRouter = Router();
meRouter.use(requireAuth);

// Light badge counts for the header (cart / wishlist / unread notifications).
meRouter.get('/counts', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const [cartAgg, wishlist, notifications] = await Promise.all([
      prisma.cartItem.aggregate({
        where: { cart: { userId }, variant: { product: { status: 'APPROVED' } } },
        _sum: { quantity: true },
      }),
      prisma.wishlist.count({ where: { userId, product: { status: 'APPROVED' } } }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    const body: MyCounts = {
      cart: cartAgg._sum.quantity ?? 0,
      wishlist,
      notifications,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Account dashboard
// ---------------------------------------------------------------------------

function toPaymentMethod(row: {
  id: string;
  kind: string;
  brand: string;
  label: string;
  holderName: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  isDefault: boolean;
}): SavedPaymentMethodInfo {
  const kind = PAYMENT_METHOD_KINDS.includes(row.kind as PaymentMethodKind)
    ? (row.kind as PaymentMethodKind)
    : 'CARD';
  // A card is expired once its expiry month is behind us.
  const now = new Date();
  const isExpired =
    kind === 'CARD' &&
    row.expiryYear !== null &&
    row.expiryMonth !== null &&
    new Date(row.expiryYear, row.expiryMonth, 1) <= now;

  return {
    id: row.id,
    kind,
    brand: row.brand,
    label: row.label,
    holderName: row.holderName,
    expiryMonth: row.expiryMonth,
    expiryYear: row.expiryYear,
    isDefault: row.isDefault,
    isExpired,
  };
}

/** Products this shopper looked at recently, newest first and de-duplicated. */
async function recentlyViewedFor(userId: string, take = 8): Promise<ProductListItem[]> {
  const views = await prisma.productView.findMany({
    where: { userId, product: { status: 'APPROVED' } },
    orderBy: { createdAt: 'desc' },
    take: take * 6, // over-fetch: the same product is often viewed repeatedly
    select: { productId: true },
  });
  const seen: string[] = [];
  for (const view of views) {
    if (!seen.includes(view.productId)) seen.push(view.productId);
    if (seen.length === take) break;
  }
  if (seen.length === 0) return [];

  const products = await prisma.product.findMany({
    where: { id: { in: seen } },
    include: productListItemInclude,
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  // Preserve view order, which the query above lost.
  return seen.flatMap((id) => {
    const product = byId.get(id);
    return product ? [toProductListItem(product)] : [];
  });
}

// Everything the account overview renders, in one round trip.
meRouter.get('/overview', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const now = new Date();

    const [user, orderCount, wishlist, couponCount, returnCount, recentOrders, addresses, methods, viewed] =
      await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.order.count({ where: { userId } }),
        prisma.wishlist.count({ where: { userId, product: { status: 'APPROVED' } } }),
        prisma.coupon.count({
          where: {
            isActive: true,
            OR: [{ startsAt: null }, { startsAt: { lte: now } }],
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
          },
        }),
        prisma.return.count({ where: { orderItem: { order: { userId } } } }),
        prisma.order.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 4,
          include: {
            _count: { select: { items: true } },
            items: {
              take: 4,
              include: {
                product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
              },
            },
          },
        }),
        prisma.address.findMany({
          where: { userId },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        }),
        prisma.savedPaymentMethod.findMany({
          where: { userId },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        }),
        recentlyViewedFor(userId),
      ]);
    if (!user) throw ApiError.notFound('Account not found');

    const defaultAddress = addresses.find((a) => a.isDefault) ?? addresses[0] ?? null;
    const body: AccountOverview = {
      profile: {
        name: user.name,
        phone: user.phone,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        premiumSince: user.premiumSince?.toISOString() ?? null,
        memberSince: user.createdAt.toISOString(),
      },
      stats: {
        orders: orderCount,
        wishlist,
        walletPaise: creditsToPaise(user.creditsBalance),
        walletCredits: user.creditsBalance,
        coupons: couponCount,
        returns: returnCount,
      },
      recentOrders: recentOrders.map((o) => {
        const images = o.items
          .map((i) => i.product.images[0]?.url)
          .filter((url): url is string => !!url);
        return {
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          totalPaise: o.totalPaise,
          itemCount: o._count.items,
          previewImageUrl: images[0] ?? null,
          previewImages: images.slice(0, 4),
          productCount: o._count.items,
          // The overview card only needs the essentials.
          paymentProvider: null,
          deliveredAt: null,
          etaFrom: null,
          etaTo: null,
          canBuyAgain: false,
          createdAt: o.createdAt.toISOString(),
        };
      }),
      defaultAddress: defaultAddress ? toAddressInfo(defaultAddress) : null,
      addressCount: addresses.length,
      paymentMethods: methods.map(toPaymentMethod),
      recentlyViewed: viewed,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/recently-viewed', async (req, res, next) => {
  try {
    const take = Math.min(Number(req.query.limit) || 12, 24);
    res.json({ success: true, data: await recentlyViewedFor(req.auth!.userId, take) });
  } catch (err) {
    next(err);
  }
});

// Every return this shopper has raised, newest first, with per-status counts.
meRouter.get('/returns', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const filter = RETURN_FILTERS.includes(req.query.status as ReturnFilter)
      ? (req.query.status as ReturnFilter)
      : 'ALL';

    const rows = await prisma.return.findMany({
      where: { orderItem: { order: { userId } } },
      orderBy: { createdAt: 'desc' },
      include: {
        refund: true,
        orderItem: {
          include: {
            order: { select: { id: true, orderNumber: true, createdAt: true } },
            product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
          },
        },
      },
    });

    const mapped: MyReturnRow[] = rows.map((r) => ({
      id: r.id,
      // Short, stable and readable — the id itself is a cuid.
      requestId: `RT-${r.id.slice(-6).toUpperCase()}`,
      orderId: r.orderItem.order.id,
      orderNumber: r.orderItem.order.orderNumber,
      orderedAt: r.orderItem.order.createdAt.toISOString(),
      productTitle: r.orderItem.title,
      productSlug: r.orderItem.product.slug,
      imageUrl: r.orderItem.product.images[0]?.url ?? null,
      size: r.orderItem.size,
      color: r.orderItem.color,
      variantLabel: r.orderItem.variantLabel,
      quantity: r.orderItem.quantity,
      pricePaise: r.orderItem.pricePaise,
      status: r.status,
      reason: r.reasonCategory,
      details: r.reason || null,
      rejectionReason: r.rejectionReason,
      requestedAt: r.createdAt.toISOString(),
      approvedAt: r.approvedAt?.toISOString() ?? null,
      receivedAt: r.receivedAt?.toISOString() ?? null,
      rejectedAt: r.rejectedAt?.toISOString() ?? null,
      awbNumber: r.orderItem.awbNumber,
      courierName: r.orderItem.courierName,
      refund: r.refund
        ? {
            status: r.refund.status,
            amountPaise: r.refund.amountPaise,
            processedAt: r.refund.processedAt?.toISOString() ?? null,
          }
        : null,
    }));

    const counts = Object.fromEntries(
      RETURN_FILTERS.map((f) => [
        f,
        f === 'ALL' ? mapped.length : mapped.filter((r) => r.status === f).length,
      ]),
    ) as Record<ReturnFilter, number>;

    const body: MyReturnsResponse = {
      items: filter === 'ALL' ? mapped : mapped.filter((r) => r.status === filter),
      summary: {
        counts,
        refundedPaise: mapped
          .filter((r) => r.refund?.status === 'PROCESSED')
          .reduce((sum, r) => sum + (r.refund?.amountPaise ?? 0), 0),
        pendingRefundPaise: mapped
          .filter((r) => r.refund && r.refund.status !== 'PROCESSED')
          .reduce((sum, r) => sum + (r.refund?.amountPaise ?? 0), 0),
      },
      returnWindowDays: env.RETURN_WINDOW_DAYS,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Saved payment methods (display fields only — no PAN/CVV ever reaches us)
// ---------------------------------------------------------------------------

meRouter.get('/payment-methods', async (req, res, next) => {
  try {
    const rows = await prisma.savedPaymentMethod.findMany({
      where: { userId: req.auth!.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, data: rows.map(toPaymentMethod) });
  } catch (err) {
    next(err);
  }
});

meRouter.post('/payment-methods', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const input = savedPaymentMethodSchema.parse(req.body);
    const count = await prisma.savedPaymentMethod.count({ where: { userId } });
    const makeDefault = input.isDefault ?? count === 0; // first card is the default
    if (makeDefault) {
      await prisma.savedPaymentMethod.updateMany({ where: { userId }, data: { isDefault: false } });
    }
    const row = await prisma.savedPaymentMethod.create({
      data: {
        userId,
        kind: input.kind,
        brand: input.brand,
        label: input.label,
        holderName: input.holderName ?? null,
        expiryMonth: input.expiryMonth ?? null,
        expiryYear: input.expiryYear ?? null,
        isDefault: makeDefault,
      },
    });
    res.json({ success: true, data: toPaymentMethod(row) });
  } catch (err) {
    next(err);
  }
});

meRouter.post('/payment-methods/:id/default', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const owned = await prisma.savedPaymentMethod.findFirst({
      where: { id: req.params.id, userId },
    });
    if (!owned) throw ApiError.notFound('Payment method not found');
    await prisma.$transaction([
      prisma.savedPaymentMethod.updateMany({ where: { userId }, data: { isDefault: false } }),
      prisma.savedPaymentMethod.update({ where: { id: owned.id }, data: { isDefault: true } }),
    ]);
    const rows = await prisma.savedPaymentMethod.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, data: rows.map(toPaymentMethod) });
  } catch (err) {
    next(err);
  }
});

meRouter.delete('/payment-methods/:id', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const { count } = await prisma.savedPaymentMethod.deleteMany({
      where: { id: req.params.id, userId },
    });
    if (count === 0) throw ApiError.notFound('Payment method not found');
    // Deleting the default promotes the next-newest card.
    const remaining = await prisma.savedPaymentMethod.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (remaining.length > 0 && !remaining.some((m) => m.isDefault)) {
      await prisma.savedPaymentMethod.update({
        where: { id: remaining[0].id },
        data: { isDefault: true },
      });
      remaining[0].isDefault = true;
    }
    res.json({ success: true, data: remaining.map(toPaymentMethod) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// My coupon wallet
// ---------------------------------------------------------------------------

/**
 * Every coupon this shopper could care about, tagged with their own status.
 * Expired and already-used codes stay in the list so the wallet has history.
 */
meRouter.get('/coupons', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const now = new Date();

    const [user, coupons, myCouponOrders] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { isPremium: true } }),
      prisma.coupon.findMany({
        where: { isActive: true },
        orderBy: [{ minSubtotalPaise: 'asc' }, { code: 'asc' }],
        take: 60,
      }),
      prisma.order.findMany({
        where: { userId, couponCode: { not: null }, status: { not: 'CANCELLED' } },
        select: { couponCode: true, couponDiscountPaise: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Fold my order history into per-code usage.
    const usage = new Map<string, { times: number; lastUsedAt: Date; savedPaise: number }>();
    for (const order of myCouponOrders) {
      const code = order.couponCode!;
      const row = usage.get(code) ?? { times: 0, lastUsedAt: order.createdAt, savedPaise: 0 };
      row.times += 1;
      row.savedPaise += order.couponDiscountPaise;
      if (order.createdAt > row.lastUsedAt) row.lastUsedAt = order.createdAt;
      usage.set(code, row);
    }

    const rows: MyCoupon[] = coupons.map((coupon) => {
      const mine = usage.get(coupon.code);
      const timesUsed = mine?.times ?? 0;
      const kind = (coupon.kind as MyCoupon['kind']) ?? 'STANDARD';

      let status: MyCoupon['status'] = 'AVAILABLE';
      let lockedReason: string | null = null;
      if (coupon.expiresAt && coupon.expiresAt < now) {
        status = 'EXPIRED';
      } else if (coupon.perUserLimit !== null && timesUsed >= coupon.perUserLimit) {
        status = 'USED';
      } else if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
        status = 'LOCKED';
        lockedReason = 'Fully redeemed — no codes left';
      } else if (coupon.startsAt && coupon.startsAt > now) {
        status = 'LOCKED';
        lockedReason = `Starts on ${coupon.startsAt.toLocaleDateString('en-IN')}`;
      } else if (kind === 'PREMIUM' && !user?.isPremium) {
        status = 'LOCKED';
        lockedReason = 'Clowe Premium members only';
      }

      return {
        code: coupon.code,
        description: coupon.description,
        type: coupon.type,
        value: coupon.value,
        minSubtotalPaise: coupon.minSubtotalPaise,
        maxDiscountPaise: coupon.maxDiscountPaise,
        expiresAt: coupon.expiresAt?.toISOString() ?? null,
        kind,
        status,
        timesUsed,
        lastUsedAt: mine?.lastUsedAt.toISOString() ?? null,
        lockedReason,
      };
    });

    const body: MyCouponsResponse = {
      coupons: rows,
      summary: {
        total: rows.length,
        available: rows.filter((r) => r.status === 'AVAILABLE').length,
        used: rows.filter((r) => r.status === 'USED').length,
        expired: rows.filter((r) => r.status === 'EXPIRED').length,
        totalSavingsPaise: myCouponOrders.reduce((sum, o) => sum + o.couponDiscountPaise, 0),
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
