import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import type { SellerProfile } from '@prisma/client';
import {
  phoneSchema,
  sellerRegisterSchema,
  sellerProductUpsertSchema,
  type SellerOrderItemRow,
  type SellerProductDetail,
  type SellerProductListItem,
  type SellerProfileInfo,
  type SellerStats,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { shippingProvider } from '../services/shipping';
import { sendMessageSafe } from '../services/messaging';

export const sellerRouter = Router();

declare module 'express-serve-static-core' {
  interface Request {
    seller?: SellerProfile;
  }
}

/**
 * Loads the caller's seller profile from the DB (not the JWT), so a freshly
 * registered seller works without waiting for a token refresh.
 */
async function requireSeller(req: Request, _res: Response, next: NextFunction) {
  try {
    const profile = await prisma.sellerProfile.findUnique({
      where: { userId: req.auth!.userId },
    });
    if (!profile) {
      throw ApiError.forbidden('Register as a seller first', 'SELLER_PROFILE_REQUIRED');
    }
    req.seller = profile;
    next();
  } catch (err) {
    next(err);
  }
}

/** Listing products requires an APPROVED (not just registered) seller. */
function requireApprovedSeller(req: Request, _res: Response, next: NextFunction) {
  if (req.seller!.status !== 'APPROVED') {
    return next(
      ApiError.forbidden(
        'Your seller account is not approved yet. Products can be added once the admin approves you.',
        'SELLER_NOT_APPROVED',
      ),
    );
  }
  next();
}

function toProfileInfo(p: SellerProfile): SellerProfileInfo {
  return {
    id: p.id,
    shopName: p.shopName,
    description: p.description,
    status: p.status,
    rejectionReason: p.rejectionReason,
    city: p.city,
    state: p.state,
    createdAt: p.createdAt.toISOString(),
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const newSku = () => `CLW-${randomBytes(4).toString('hex').toUpperCase()}`;

// Public: is this phone registered as a seller? The seller-only login page
// uses this to refuse OTPs for non-seller numbers.
sellerRouter.post('/check-phone', async (req, res, next) => {
  try {
    const { phone } = z.object({ phone: phoneSchema }).parse(req.body);
    const user = await prisma.user.findUnique({
      where: { phone },
      include: { sellerProfile: { select: { id: true } } },
    });
    res.json({ success: true, data: { isSeller: !!user?.sellerProfile } });
  } catch (err) {
    next(err);
  }
});

sellerRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Registration & profile
// ---------------------------------------------------------------------------

// Apply to become a seller. Profile starts PENDING; admin approves in Phase 4.
sellerRouter.post('/register', async (req, res, next) => {
  try {
    const input = sellerRegisterSchema.parse(req.body);
    const existing = await prisma.sellerProfile.findUnique({
      where: { userId: req.auth!.userId },
    });
    if (existing) {
      throw ApiError.badRequest('You have already registered as a seller', 'ALREADY_REGISTERED');
    }

    const profile = await prisma.sellerProfile.create({
      data: { userId: req.auth!.userId, ...input },
    });
    // Role becomes SELLER (they can still shop as a customer).
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: { role: 'SELLER' },
    });
    res.json({ success: true, data: toProfileInfo(profile) });
  } catch (err) {
    next(err);
  }
});

sellerRouter.get('/profile', requireSeller, (req, res) => {
  res.json({ success: true, data: toProfileInfo(req.seller!) });
});

// ---------------------------------------------------------------------------
// Products (own products only)
// ---------------------------------------------------------------------------

sellerRouter.get('/products', requireSeller, async (req, res, next) => {
  try {
    const products = await prisma.product.findMany({
      where: { sellerId: req.seller!.id, status: { not: 'ARCHIVED' } },
      orderBy: { updatedAt: 'desc' },
      include: {
        category: { select: { name: true } },
        images: { orderBy: { sortOrder: 'asc' }, take: 1 },
        variants: { select: { stock: true, pricePaise: true } },
      },
    });
    const items: SellerProductListItem[] = products.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      status: p.status,
      rejectionReason: p.rejectionReason,
      categoryName: p.category.name,
      imageUrl: p.images[0]?.url ?? null,
      variantCount: p.variants.length,
      totalStock: p.variants.reduce((sum, v) => sum + v.stock, 0),
      minPricePaise: Math.min(...p.variants.map((v) => v.pricePaise), p.basePricePaise),
      updatedAt: p.updatedAt.toISOString(),
    }));
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
});

/** Fetch one of the seller's own products or 404. */
async function ownProduct(req: Request, id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { images: { orderBy: { sortOrder: 'asc' } }, variants: true },
  });
  if (!product || product.sellerId !== req.seller!.id) {
    throw ApiError.notFound('Product not found');
  }
  return product;
}

sellerRouter.get('/products/:id', requireSeller, async (req, res, next) => {
  try {
    const p = await ownProduct(req, req.params.id);
    const body: SellerProductDetail = {
      id: p.id,
      title: p.title,
      categoryId: p.categoryId,
      brand: p.brand,
      description: p.description,
      status: p.status,
      rejectionReason: p.rejectionReason,
      imageUrls: p.images.map((i) => i.url),
      variants: p.variants.map((v) => ({
        id: v.id,
        size: v.size,
        color: v.color,
        pricePaise: v.pricePaise,
        mrpPaise: v.mrpPaise,
        stock: v.stock,
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Create a product — goes live only after admin approval (status PENDING).
sellerRouter.post('/products', requireSeller, requireApprovedSeller, async (req, res, next) => {
  try {
    const input = sellerProductUpsertSchema.parse(req.body);
    const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!category) throw ApiError.badRequest('Category not found', 'CATEGORY_NOT_FOUND');

    const basePricePaise = Math.min(...input.variants.map((v) => v.pricePaise));
    const slug = `${slugify(`${input.brand ?? ''} ${input.title}`)}-${randomBytes(3).toString('hex')}`;

    const product = await prisma.product.create({
      data: {
        sellerId: req.seller!.id,
        categoryId: input.categoryId,
        title: input.title,
        slug,
        brand: input.brand ?? null,
        description: input.description,
        basePricePaise,
        status: 'PENDING',
        images: {
          create: input.imageUrls.map((url, i) => ({ url, altText: input.title, sortOrder: i })),
        },
        variants: {
          create: input.variants.map((v) => ({
            size: v.size,
            color: v.color,
            sku: newSku(),
            pricePaise: v.pricePaise,
            mrpPaise: v.mrpPaise ?? null,
            stock: v.stock,
          })),
        },
      },
    });
    res.json({ success: true, data: { id: product.id, status: product.status } });
  } catch (err) {
    next(err);
  }
});

// Edit a product — resets status to PENDING for re-approval.
sellerRouter.put('/products/:id', requireSeller, requireApprovedSeller, async (req, res, next) => {
  try {
    const input = sellerProductUpsertSchema.parse(req.body);
    const product = await ownProduct(req, req.params.id);

    const keptIds = input.variants.filter((v) => v.id).map((v) => v.id!);
    const basePricePaise = Math.min(...input.variants.map((v) => v.pricePaise));

    await prisma.$transaction([
      prisma.product.update({
        where: { id: product.id },
        data: {
          title: input.title,
          categoryId: input.categoryId,
          brand: input.brand ?? null,
          description: input.description,
          basePricePaise,
          status: 'PENDING', // edits require re-approval
          rejectionReason: null,
        },
      }),
      prisma.productImage.deleteMany({ where: { productId: product.id } }),
      prisma.productImage.createMany({
        data: input.imageUrls.map((url, i) => ({
          productId: product.id,
          url,
          altText: input.title,
          sortOrder: i,
        })),
      }),
      // Variants: update kept ones, remove missing, add new.
      prisma.productVariant.deleteMany({
        where: { productId: product.id, id: { notIn: keptIds } },
      }),
      ...input.variants
        .filter((v) => v.id)
        .map((v) =>
          prisma.productVariant.update({
            where: { id: v.id! },
            data: {
              size: v.size,
              color: v.color,
              pricePaise: v.pricePaise,
              mrpPaise: v.mrpPaise ?? null,
              stock: v.stock,
            },
          }),
        ),
      ...(input.variants.some((v) => !v.id)
        ? [
            prisma.productVariant.createMany({
              data: input.variants
                .filter((v) => !v.id)
                .map((v) => ({
                  productId: product.id,
                  size: v.size,
                  color: v.color,
                  sku: newSku(),
                  pricePaise: v.pricePaise,
                  mrpPaise: v.mrpPaise ?? null,
                  stock: v.stock,
                })),
            }),
          ]
        : []),
    ]);
    res.json({ success: true, data: { id: product.id, status: 'PENDING' } });
  } catch (err) {
    next(err);
  }
});

// Archive (soft delete) a product.
sellerRouter.delete('/products/:id', requireSeller, async (req, res, next) => {
  try {
    const product = await ownProduct(req, req.params.id);
    await prisma.product.update({ where: { id: product.id }, data: { status: 'ARCHIVED' } });
    res.json({ success: true, data: { archived: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Orders (this seller's items only) — will populate once Phase 5 ships
// ---------------------------------------------------------------------------

sellerRouter.get('/orders', requireSeller, async (req, res, next) => {
  try {
    // Unpaid orders (order.status PLACED) are hidden from sellers.
    const items = await prisma.orderItem.findMany({
      where: { sellerId: req.seller!.id, order: { status: { not: 'PLACED' } } },
      orderBy: { order: { createdAt: 'desc' } },
      include: { order: true },
      take: 100,
    });
    const rows: SellerOrderItemRow[] = items.map((i) => ({
      id: i.id,
      orderNumber: i.order.orderNumber,
      placedAt: i.order.createdAt.toISOString(),
      title: i.title,
      size: i.size,
      color: i.color,
      quantity: i.quantity,
      pricePaise: i.pricePaise,
      status: i.status,
      shipTo: {
        name: i.order.shipName,
        city: i.order.shipCity,
        state: i.order.shipState,
        pincode: i.order.shipPincode,
      },
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Mark an order item shipped / delivered.
sellerRouter.patch('/orders/:itemId/status', requireSeller, async (req, res, next) => {
  try {
    const { action } = z.object({ action: z.enum(['ship', 'deliver']) }).parse(req.body);
    const item = await prisma.orderItem.findUnique({
      where: { id: req.params.itemId },
      include: { order: { include: { user: { select: { id: true, phone: true } } } } },
    });
    if (!item || item.sellerId !== req.seller!.id) throw ApiError.notFound('Order item not found');

    if (action === 'ship') {
      // Only paid (CONFIRMED) items can ship — PLACED means payment pending.
      if (item.status !== 'CONFIRMED') {
        throw ApiError.badRequest(`Cannot ship an item in status ${item.status}`);
      }
      // Book the shipment with the delivery partner (mock AWB in dev).
      const shipment = await shippingProvider.createShipment({
        orderNumber: item.order.orderNumber,
        orderItemId: item.id,
        destinationCity: item.order.shipCity,
        destinationPincode: item.order.shipPincode,
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
          },
        }),
      ]);
      sendMessageSafe({
        channel: 'whatsapp',
        to: `+91${item.order.user.phone}`,
        body: `Your Clowe item "${item.title}" has shipped via ${shipment.courierName} (AWB ${shipment.awbNumber}). Track: /track 🚚`,
      });
    } else {
      if (item.status !== 'SHIPPED') {
        throw ApiError.badRequest(`Cannot deliver an item in status ${item.status}`);
      }
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
          },
        }),
      ]);
    }
    res.json({ success: true, data: { id: item.id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

sellerRouter.get('/stats', requireSeller, async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const [totalProducts, liveProducts, pendingProducts, orderAgg, lowStockVariants] =
      await Promise.all([
        prisma.product.count({ where: { sellerId, status: { not: 'ARCHIVED' } } }),
        prisma.product.count({ where: { sellerId, status: 'APPROVED' } }),
        prisma.product.count({ where: { sellerId, status: 'PENDING' } }),
        prisma.orderItem.aggregate({
          // PLACED = unpaid; excluded from sales stats along with cancelled/returned.
          where: { sellerId, status: { notIn: ['PLACED', 'CANCELLED', 'RETURNED'] } },
          _count: { id: true },
          _sum: { quantity: true },
        }),
        prisma.productVariant.count({
          where: { product: { sellerId, status: { not: 'ARCHIVED' } }, stock: { lt: 5 } },
        }),
      ]);

    // Revenue = sum(price × qty) over non-cancelled/returned items.
    const revenueItems = await prisma.orderItem.findMany({
      where: { sellerId, status: { notIn: ['PLACED', 'CANCELLED', 'RETURNED'] } },
      select: { pricePaise: true, quantity: true },
    });
    const revenuePaise = revenueItems.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);

    const body: SellerStats = {
      totalProducts,
      liveProducts,
      pendingProducts,
      totalOrderItems: orderAgg._count.id,
      unitsSold: orderAgg._sum.quantity ?? 0,
      revenuePaise,
      lowStockVariants,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
