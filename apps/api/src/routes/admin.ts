import { Router } from 'express';
import { z } from 'zod';
import {
  categoryUpsertSchema,
  productDecisionSchema,
  sellerDecisionSchema,
  type AdminCategoryRow,
  type AdminOrderRow,
  type AdminProductDetail,
  type AdminProductRow,
  type AdminSellerRow,
  type AdminStats,
  type AdminUserRow,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

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
    const [users, sellers, products, liveProducts, orders, pendingSellers, pendingProducts] =
      await Promise.all([
        prisma.user.count(),
        prisma.sellerProfile.count(),
        prisma.product.count({ where: { status: { not: 'ARCHIVED' } } }),
        prisma.product.count({ where: { status: 'APPROVED' } }),
        prisma.order.count(),
        prisma.sellerProfile.count({ where: { status: 'PENDING' } }),
        prisma.product.count({ where: { status: 'PENDING' } }),
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
      totals: { users, sellers, products, liveProducts, orders, unitsSold, revenuePaise },
      pending: { sellers: pendingSellers, products: pendingProducts },
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

adminRouter.get('/sellers', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const sellers = await prisma.sellerProfile.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { phone: true, name: true } },
        _count: { select: { products: true } },
      },
    });
    const rows: AdminSellerRow[] = sellers.map((s) => ({
      id: s.id,
      shopName: s.shopName,
      status: s.status,
      rejectionReason: s.rejectionReason,
      phone: s.user.phone,
      userName: s.user.name,
      city: s.city,
      state: s.state,
      gstNumber: s.gstNumber,
      panNumber: s.panNumber,
      productCount: s._count.products,
      createdAt: s.createdAt.toISOString(),
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/sellers/:id', async (req, res, next) => {
  try {
    const { action, reason } = sellerDecisionSchema.parse(req.body);
    const seller = await prisma.sellerProfile.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true } } },
    });
    if (!seller) throw ApiError.notFound('Seller not found');

    const status = action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'SUSPENDED';
    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        status,
        rejectionReason: action === 'approve' ? null : (reason ?? null),
        approvedAt: action === 'approve' ? new Date() : seller.approvedAt,
      },
    });

    const messages = {
      approve: { title: 'Seller account approved 🎉', body: 'You can now list products on Clowe.' },
      reject: {
        title: 'Seller application rejected',
        body: reason ? `Reason: ${reason}` : 'Contact support for details.',
      },
      suspend: {
        title: 'Seller account suspended',
        body: reason ? `Reason: ${reason}` : 'Contact support for details.',
      },
    } as const;
    await prisma.notification.create({
      data: { userId: seller.user.id, type: `SELLER_${status}`, ...messages[action] },
    });

    res.json({ success: true, data: { id: seller.id, status } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Product moderation
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
              OR: [
                { phone: { contains: q } },
                { name: { contains: q, mode: 'insensitive' } },
              ],
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
// Order overview
// ---------------------------------------------------------------------------

adminRouter.get('/orders', async (_req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { name: true, phone: true } },
        _count: { select: { items: true } },
      },
    });
    const rows: AdminOrderRow[] = orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.user.name,
      customerPhone: o.user.phone,
      status: o.status,
      itemCount: o._count.items,
      totalPaise: o.totalPaise,
      createdAt: o.createdAt.toISOString(),
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});
