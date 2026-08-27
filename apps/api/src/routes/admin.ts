import { Router } from 'express';
import { z } from 'zod';
import {
  adminReturnOverrideSchema,
  adDecisionSchema,
  categoryUpsertSchema,
  productDecisionSchema,
  type AdminCategoryRow,
  type AdminProductDetail,
  type AdminProductRow,
  type AdminReturnRow,
  type AdminSellerReferralRow,
  type AdminAdRow,
  type AdminStats,
  type AdminUserRow,
  updateSettingsSchema,
  voidReferralSchema,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { sendToUserSafe } from '../services/messaging';
import { getSettings, setSetting } from '../services/settingsService';
import { expireDueAds } from './ads';
import {
  SELLER_REFERRAL_TARGET_PAISE,
  deliveredSalesPaise,
} from '../services/sellerReferralService';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole('ADMIN'));

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ---------------------------------------------------------------------------
// Platform analytics
// ---------------------------------------------------------------------------

adminRouter.get('/stats', async (_req, res, next) => {
  try {
    const [
      users,
      sellers,
      products,
      liveProducts,
      orders,
      pendingSellers,
      pendingProducts,
      openComplaints,
      totalReturns,
      pendingReturns,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.sellerProfile.count(),
      prisma.product.count({ where: { status: { not: 'ARCHIVED' } } }),
      prisma.product.count({ where: { status: 'APPROVED' } }),
      prisma.order.count(),
      prisma.sellerProfile.count({ where: { status: 'PENDING' } }),
      prisma.product.count({ where: { status: 'PENDING' } }),
      prisma.complaint.count({ where: { status: 'OPEN' } }),
      prisma.return.count(),
      prisma.return.count({ where: { status: 'REQUESTED' } }),
    ]);

    // Sales aggregates from order items (excludes cancelled/returned).
    const soldItems = await prisma.orderItem.findMany({
      // PLACED = unpaid; excluded from sales stats along with cancelled/returned.
      where: { status: { notIn: ['PLACED', 'CANCELLED', 'RETURNED'] } },
      select: { productId: true, sellerId: true, quantity: true, pricePaise: true },
    });
    const unitsSold = soldItems.reduce((sum, i) => sum + i.quantity, 0);
    const revenuePaise = soldItems.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);

    // Top products by units sold.
    const byProduct = new Map<string, { unitsSold: number; revenuePaise: number }>();
    for (const item of soldItems) {
      const agg = byProduct.get(item.productId) ?? { unitsSold: 0, revenuePaise: 0 };
      agg.unitsSold += item.quantity;
      agg.revenuePaise += item.pricePaise * item.quantity;
      byProduct.set(item.productId, agg);
    }
    const topIds = [...byProduct.entries()]
      .sort((a, b) => b[1].unitsSold - a[1].unitsSold)
      .slice(0, 10);
    const topProductRecords = await prisma.product.findMany({
      where: { id: { in: topIds.map(([id]) => id) } },
      select: { id: true, title: true },
    });
    const titleById = new Map(topProductRecords.map((p) => [p.id, p.title]));

    // Per-seller breakdown.
    const sellerProfiles = await prisma.sellerProfile.findMany({
      select: {
        id: true,
        shopName: true,
        status: true,
        _count: { select: { products: { where: { status: 'APPROVED' } } } },
      },
    });
    const bySeller = new Map<string, { unitsSold: number; revenuePaise: number }>();
    for (const item of soldItems) {
      const agg = bySeller.get(item.sellerId) ?? { unitsSold: 0, revenuePaise: 0 };
      agg.unitsSold += item.quantity;
      agg.revenuePaise += item.pricePaise * item.quantity;
      bySeller.set(item.sellerId, agg);
    }

    const body: AdminStats = {
      totals: {
        users,
        sellers,
        products,
        liveProducts,
        orders,
        unitsSold,
        revenuePaise,
        returns: totalReturns,
      },
      pending: {
        sellers: pendingSellers,
        products: pendingProducts,
        complaints: openComplaints,
        returns: pendingReturns,
      },
      topProducts: topIds.map(([id, agg]) => ({
        id,
        title: titleById.get(id) ?? 'Unknown product',
        ...agg,
      })),
      sellerBreakdown: sellerProfiles
        .map((s) => ({
          sellerId: s.id,
          shopName: s.shopName,
          status: s.status,
          liveProducts: s._count.products,
          unitsSold: bySeller.get(s.id)?.unitsSold ?? 0,
          revenuePaise: bySeller.get(s.id)?.revenuePaise ?? 0,
        }))
        .sort((a, b) => b.revenuePaise - a.revenuePaise),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Seller moderation
// ---------------------------------------------------------------------------

adminRouter.get('/products', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'PENDING';
    const products = await prisma.product.findMany({
      where: { status: status as never },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        category: { select: { name: true } },
        seller: { select: { shopName: true } },
        images: { orderBy: { sortOrder: 'asc' }, take: 1 },
        variants: { select: { pricePaise: true } },
      },
    });
    const rows: AdminProductRow[] = products.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      status: p.status,
      rejectionReason: p.rejectionReason,
      brand: p.brand,
      categoryName: p.category.name,
      shopName: p.seller.shopName,
      imageUrl: p.images[0]?.url ?? null,
      minPricePaise: Math.min(...p.variants.map((v) => v.pricePaise), p.basePricePaise),
      variantCount: p.variants.length,
      createdAt: p.createdAt.toISOString(),
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Full product detail for the review screen (any status).
adminRouter.get('/products/:id', async (req, res, next) => {
  try {
    const p = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        category: { select: { name: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        variants: { orderBy: [{ color: 'asc' }, { size: 'asc' }] },
        seller: { include: { user: { select: { phone: true } } } },
      },
    });
    if (!p) throw ApiError.notFound('Product not found');

    const body: AdminProductDetail = {
      id: p.id,
      title: p.title,
      slug: p.slug,
      status: p.status,
      rejectionReason: p.rejectionReason,
      brand: p.brand,
      categoryName: p.category.name,
      description: p.description,
      imageUrls: p.images.map((i) => i.url),
      variants: p.variants.map((v) => ({
        sku: v.sku,
        size: v.size,
        color: v.color,
        pricePaise: v.pricePaise,
        mrpPaise: v.mrpPaise,
        stock: v.stock,
      })),
      seller: {
        shopName: p.seller.shopName,
        status: p.seller.status,
        phone: p.seller.user.phone,
        city: p.seller.city,
        state: p.seller.state,
        gstNumber: p.seller.gstNumber,
        panNumber: p.seller.panNumber,
      },
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/products/:id', async (req, res, next) => {
  try {
    const { action, reason } = productDecisionSchema.parse(req.body);
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { seller: { select: { userId: true } } },
    });
    if (!product) throw ApiError.notFound('Product not found');

    const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
    await prisma.product.update({
      where: { id: product.id },
      data: {
        status,
        rejectionReason: action === 'approve' ? null : (reason ?? null),
        approvedAt: action === 'approve' ? new Date() : product.approvedAt,
      },
    });
    await prisma.notification.create({
      data: {
        userId: product.seller.userId,
        type: `PRODUCT_${status}`,
        title: action === 'approve' ? 'Product approved ✅' : 'Product rejected',
        body:
          action === 'approve'
            ? `"${product.title}" is now live on Clowe.`
            : `"${product.title}" was rejected.${reason ? ` Reason: ${reason}` : ''}`,
      },
    });
    res.json({ success: true, data: { id: product.id, status } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Category management
// ---------------------------------------------------------------------------

adminRouter.get('/categories', async (_req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    const rows: AdminCategoryRow[] = categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      parentId: c.parentId,
      icon: c.icon,
      isActive: c.isActive,
      sortOrder: c.sortOrder,
      productCount: c._count.products,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/categories', async (req, res, next) => {
  try {
    const input = categoryUpsertSchema.parse(req.body);
    if (input.parentId) {
      const parent = await prisma.category.findUnique({ where: { id: input.parentId } });
      if (!parent) throw ApiError.badRequest('Parent category not found');
      if (parent.parentId) throw ApiError.badRequest('Categories can only be two levels deep');
    }
    // Slug: prefix child slugs with the parent for readability, keep unique.
    let slug = slugify(input.name);
    if (input.parentId) {
      const parent = await prisma.category.findUnique({ where: { id: input.parentId } });
      slug = slugify(`${parent!.name} ${input.name}`);
    }
    const existing = await prisma.category.findUnique({ where: { slug } });
    if (existing) throw ApiError.badRequest('A category with this name already exists');

    const category = await prisma.category.create({
      data: {
        name: input.name,
        slug,
        parentId: input.parentId ?? null,
        imageUrl: input.imageUrl,
        icon: input.icon ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    res.json({ success: true, data: { id: category.id, slug: category.slug } });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/categories/:id', async (req, res, next) => {
  try {
    const input = categoryUpsertSchema.partial().parse(req.body);
    const category = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!category) throw ApiError.notFound('Category not found');

    await prisma.category.update({
      where: { id: category.id },
      data: {
        name: input.name,
        imageUrl: input.imageUrl,
        icon: input.icon,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      },
    });
    res.json({ success: true, data: { id: category.id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

adminRouter.get('/users', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const role = typeof req.query.role === 'string' ? req.query.role : undefined;
    const users = await prisma.user.findMany({
      where: {
        ...(role ? { role: role as never } : {}),
        ...(q
          ? {
              OR: [{ phone: { contains: q } }, { name: { contains: q, mode: 'insensitive' } }],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { orders: true } } },
    });
    const rows: AdminUserRow[] = users.map((u) => ({
      id: u.id,
      phone: u.phone,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      orderCount: u._count.orders,
      createdAt: u.createdAt.toISOString(),
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/users/:id', async (req, res, next) => {
  try {
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw ApiError.notFound('User not found');
    if (user.role === 'ADMIN') throw ApiError.forbidden('Cannot deactivate an admin account');

    await prisma.user.update({ where: { id: user.id }, data: { isActive } });
    // Blocking a user also cuts their sessions.
    if (!isActive) {
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    res.json({ success: true, data: { id: user.id, isActive } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Complaints
// ---------------------------------------------------------------------------

// Orders moved to routes/adminOrders (the Order Management desk), mounted
// ahead of this router at /api/admin/orders.

// ---------------------------------------------------------------------------
// Returns oversight (all sellers) + dispute-resolution override
// ---------------------------------------------------------------------------

adminRouter.get('/returns', async (req, res, next) => {
  try {
    const { status } = z
      .object({
        status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED']).optional(),
      })
      .parse(req.query);
    const returns = await prisma.return.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        refund: true,
        user: { select: { phone: true } },
        orderItem: {
          include: {
            order: { select: { orderNumber: true, shipName: true } },
            seller: { select: { shopName: true } },
            product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
          },
        },
      },
    });
    const rows: AdminReturnRow[] = returns.map((r) => ({
      id: r.id,
      orderItemId: r.orderItemId,
      orderNumber: r.orderItem.order.orderNumber,
      title: r.orderItem.title,
      size: r.orderItem.size,
      color: r.orderItem.color,
      quantity: r.orderItem.quantity,
      pricePaise: r.orderItem.pricePaise,
      imageUrl: r.orderItem.product.images[0]?.url ?? null,
      customerName: r.orderItem.order.shipName,
      customerPhone: r.user.phone,
      shopName: r.orderItem.seller.shopName,
      reason: r.reasonCategory,
      details: r.reason || null,
      photos: r.photos,
      status: r.status,
      rejectionReason: r.rejectionReason,
      receivedCondition: r.receivedCondition,
      adminOverrideAt: r.adminOverrideAt?.toISOString() ?? null,
      refund: r.refund
        ? {
            status: r.refund.status,
            amountPaise: r.refund.amountPaise,
            providerRefundId: r.refund.providerRefundId,
          }
        : null,
      requestedAt: r.createdAt.toISOString(),
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Override a seller's rejection: REJECTED → APPROVED (logged, both sides notified).
adminRouter.patch('/returns/:id/override', async (req, res, next) => {
  try {
    const { note } = adminReturnOverrideSchema.parse(req.body);
    const r = await prisma.return.findUnique({
      where: { id: req.params.id },
      include: {
        orderItem: {
          include: {
            order: { include: { user: { select: { id: true, phone: true } } } },
            seller: { select: { userId: true } },
          },
        },
      },
    });
    if (!r) throw ApiError.notFound('Return not found');
    if (r.status !== 'REJECTED') {
      throw ApiError.badRequest('Only rejected returns can be overridden', 'NOT_REJECTED');
    }

    const customer = r.orderItem.order.user;
    const label = `"${r.orderItem.title}" (${r.orderItem.order.orderNumber})`;
    const overrideAt = new Date();

    await prisma.$transaction([
      prisma.return.update({
        where: { id: r.id },
        data: {
          status: 'APPROVED',
          approvedAt: overrideAt,
          adminOverrideAt: overrideAt,
          adminOverrideNote: note ?? null,
          resolvedAt: null,
        },
      }),
      // The return is live again.
      prisma.orderItem.update({
        where: { id: r.orderItemId },
        data: { status: 'RETURN_REQUESTED' },
      }),
      prisma.notification.create({
        data: {
          userId: customer.id,
          type: 'RETURN_APPROVED',
          title: 'Return approved by Clowe support ✅',
          body: `After review, your return for ${label} has been approved. Pickup will be scheduled shortly.`,
        },
      }),
      prisma.notification.create({
        data: {
          userId: r.orderItem.seller.userId,
          type: 'RETURN_OVERRIDDEN',
          title: 'Return decision overridden',
          body: `Clowe support reviewed and approved the customer's return for ${label}${note ? ` — note: "${note}"` : ''}. Please process the pickup and mark it received.`,
        },
      }),
    ]);
    // Audit trail in the server log as well.
    console.log(
      `[clowe-api] ADMIN OVERRIDE: return ${r.id} (${label}) REJECTED → APPROVED at ${overrideAt.toISOString()}${note ? ` note="${note}"` : ''}`,
    );
    sendToUserSafe(
      customer.id,
      {
        channel: 'whatsapp',
        to: `+91${customer.phone}`,
        body: `Clowe: good news — after review, your return for ${label} has been approved. Pickup will be scheduled shortly. ✅`,
      },
      { critical: true },
    );
    res.json({ success: true, data: { overridden: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Platform settings (try-on threshold, social links, ad pricing)
// ---------------------------------------------------------------------------

adminRouter.get('/settings', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getSettings() });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/settings', async (req, res, next) => {
  try {
    const input = updateSettingsSchema.parse(req.body);
    if (input.tryonMinPricePaise !== undefined) {
      await setSetting('tryonMinPricePaise', input.tryonMinPricePaise);
    }
    if (input.socialLinks !== undefined) await setSetting('socialLinks', input.socialLinks);
    if (input.adPricing !== undefined) await setSetting('adPricing', input.adPricing);
    // Seller payout economics — every rate the payout page explains.
    for (const key of [
      'payoutCommissionPercent',
      'payoutGatewayPercent',
      'payoutTdsPercent',
      'payoutMinPaise',
      'payoutHoldDays',
    ] as const) {
      if (input[key] !== undefined) await setSetting(key, input[key]);
    }
    res.json({ success: true, data: await getSettings() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Ads moderation
// ---------------------------------------------------------------------------

adminRouter.get('/ads', async (req, res, next) => {
  try {
    const { status } = z
      .object({ status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'EXPIRED']).optional() })
      .parse(req.query);
    await expireDueAds();
    const ads = await prisma.ad.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        seller: { select: { shopName: true } },
        product: {
          select: { title: true, slug: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } },
        },
      },
    });
    const rows: AdminAdRow[] = ads.map((ad) => ({
      id: ad.id,
      productId: ad.productId,
      productTitle: ad.product.title,
      productSlug: ad.product.slug,
      imageUrl: ad.product.images[0]?.url ?? null,
      placement: ad.placement,
      durationDays: ad.durationDays,
      pricePaise: ad.pricePaise,
      status: ad.status,
      rejectionReason: ad.rejectionReason,
      startAt: ad.startAt?.toISOString() ?? null,
      endAt: ad.endAt?.toISOString() ?? null,
      views: ad.views,
      clicks: ad.clicks,
      createdAt: ad.createdAt.toISOString(),
      shopName: ad.seller.shopName,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Approve (goes live now, for its duration) or reject (with reason).
adminRouter.patch('/ads/:id', async (req, res, next) => {
  try {
    const input = adDecisionSchema.parse(req.body);
    const ad = await prisma.ad.findUnique({
      where: { id: req.params.id },
      include: { seller: { select: { userId: true } }, product: { select: { title: true } } },
    });
    if (!ad) throw ApiError.notFound('Ad not found');
    if (ad.status !== 'PENDING') {
      throw ApiError.badRequest(`Only pending ads can be decided (this one is ${ad.status})`);
    }

    if (input.action === 'approve') {
      const startAt = new Date();
      const endAt = new Date(startAt.getTime() + ad.durationDays * 24 * 60 * 60 * 1000);
      await prisma.$transaction([
        prisma.ad.update({ where: { id: ad.id }, data: { status: 'ACTIVE', startAt, endAt } }),
        prisma.notification.create({
          data: {
            userId: ad.seller.userId,
            type: 'AD_APPROVED',
            title: 'Your ad is live! 📣',
            body: `Your ${ad.durationDays}-day ad for "${ad.product.title}" is now live. Amount payable: ₹${(ad.pricePaise / 100).toFixed(2)} (adjusted from payouts).`,
          },
        }),
      ]);
    } else {
      await prisma.$transaction([
        prisma.ad.update({
          where: { id: ad.id },
          data: { status: 'REJECTED', rejectionReason: input.reason },
        }),
        prisma.notification.create({
          data: {
            userId: ad.seller.userId,
            type: 'AD_REJECTED',
            title: 'Ad request declined',
            body: `Your ad for "${ad.product.title}" was declined: "${input.reason}".`,
          },
        }),
      ]);
    }
    res.json({
      success: true,
      data: { id: ad.id, status: input.action === 'approve' ? 'ACTIVE' : 'REJECTED' },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Seller referral oversight
// ---------------------------------------------------------------------------

adminRouter.get('/seller-referrals', async (_req, res, next) => {
  try {
    const referrals = await prisma.sellerReferral.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        referrer: { select: { shopName: true } },
        referred: { select: { id: true, shopName: true, status: true } },
      },
    });
    const rows: AdminSellerReferralRow[] = await Promise.all(
      referrals.map(async (r) => ({
        id: r.id,
        referrerShop: r.referrer.shopName,
        referredShop: r.referred.shopName,
        referredApproved: r.referred.status === 'APPROVED',
        salesPaise: await deliveredSalesPaise(r.referred.id),
        targetPaise: SELLER_REFERRAL_TARGET_PAISE,
        status: r.status,
        rewardPaise: r.rewardPaise,
        earnedAt: r.earnedAt?.toISOString() ?? null,
        voidReason: r.voidReason,
        createdAt: r.createdAt.toISOString(),
      })),
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Void a fraudulent referral (logged; blocks any future reward).
adminRouter.patch('/seller-referrals/:id/void', async (req, res, next) => {
  try {
    const { reason } = voidReferralSchema.parse(req.body);
    const referral = await prisma.sellerReferral.findUnique({ where: { id: req.params.id } });
    if (!referral) throw ApiError.notFound('Referral not found');
    if (referral.status === 'VOID') throw ApiError.badRequest('Already voided');

    await prisma.sellerReferral.update({
      where: { id: referral.id },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason },
    });
    console.log(
      `[clowe-api] ADMIN VOID SELLER REFERRAL: ${referral.id} (was ${referral.status}) reason="${reason}"`,
    );
    res.json({ success: true, data: { id: referral.id, status: 'VOID' } });
  } catch (err) {
    next(err);
  }
});
