import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import type { SellerProfile } from '@prisma/client';
import {
  adCreateSchema,
  phoneSchema,
  sellerRegisterSchema,
  sellerProductUpsertSchema,
  sellerReturnActionSchema,
  type SellerAdRow,
  type SellerOrderItemRow,
  type SellerProductDetail,
  type SellerProductListItem,
  type SellerProfileInfo,
  type SellerReferralInfo,
  type SellerReturnRow,
  type SellerStats,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { shippingProvider } from '../services/shipping';
import { sendMessageSafe, sendToUserSafe } from '../services/messaging';
import { paymentProvider } from '../services/payments';
import { processRefund } from '../services/refundService';
import { getSettings } from '../services/settingsService';
import { expireDueAds } from './ads';
import {
  SELLER_REFERRAL_REWARD_PAISE,
  SELLER_REFERRAL_TARGET_PAISE,
  checkSellerReferralReward,
  deliveredSalesPaise,
  ensureSellerReferralCode,
} from '../services/sellerReferralService';

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
    const { referralCode, ...input } = sellerRegisterSchema.parse(req.body);
    const existing = await prisma.sellerProfile.findUnique({
      where: { userId: req.auth!.userId },
    });
    if (existing) {
      throw ApiError.badRequest('You have already registered as a seller', 'ALREADY_REGISTERED');
    }

    // Optional seller referral code — must belong to an existing seller.
    let referrer: { id: string; userId: string; shopName: string } | null = null;
    if (referralCode) {
      referrer = await prisma.sellerProfile.findUnique({
        where: { referralCode },
        select: { id: true, userId: true, shopName: true },
      });
      if (!referrer) {
        throw ApiError.badRequest('This referral code is not valid', 'REFERRAL_CODE_INVALID');
      }
      // A seller cannot use their own code (defence in depth — a new registrant
      // has no code yet, but re-registration paths shouldn't slip through).
      if (referrer.userId === req.auth!.userId) {
        throw ApiError.badRequest('You cannot use your own referral code', 'SELF_REFERRAL');
      }
    }

    const profile = await prisma.sellerProfile.create({
      data: { userId: req.auth!.userId, ...input },
    });
    if (referrer) {
      await prisma.sellerReferral.create({
        data: { referrerId: referrer.id, referredId: profile.id },
      });
      await prisma.notification.create({
        data: {
          userId: referrer.userId,
          type: 'SELLER_REFERRAL_USED',
          title: 'Your seller referral code was used 🤝',
          body: `"${profile.shopName}" registered with your code. Once they're approved and cross ₹${SELLER_REFERRAL_TARGET_PAISE / 100} in delivered sales, you earn ₹${SELLER_REFERRAL_REWARD_PAISE / 100}.`,
        },
      });
      console.log(
        `[clowe-api] SELLER REFERRAL USED: referrer=${referrer.id} referred=${profile.id} code=${referralCode}`,
      );
    }
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

// ---------------------------------------------------------------------------
// Seller-to-seller referral program
// ---------------------------------------------------------------------------

sellerRouter.get('/referral', requireSeller, async (req, res, next) => {
  try {
    const code = await ensureSellerReferralCode(req.seller!.id);
    const referrals = await prisma.sellerReferral.findMany({
      where: { referrerId: req.seller!.id },
      orderBy: { createdAt: 'desc' },
      include: { referred: { select: { id: true, shopName: true, status: true } } },
    });
    const rows = await Promise.all(
      referrals.map(async (r) => ({
        id: r.id,
        shopName: r.referred.shopName,
        joinedAt: r.createdAt.toISOString(),
        sellerApproved: r.referred.status === 'APPROVED',
        salesPaise: await deliveredSalesPaise(r.referred.id),
        status: r.status,
        earnedAt: r.earnedAt?.toISOString() ?? null,
      })),
    );
    const body: SellerReferralInfo = {
      code,
      targetPaise: SELLER_REFERRAL_TARGET_PAISE,
      rewardPaise: SELLER_REFERRAL_REWARD_PAISE,
      creditsEarnedPaise: referrals
        .filter((r) => r.status === 'EARNED')
        .reduce((sum, r) => sum + r.rewardPaise, 0),
      referrals: rows,
    };
    res.json({ success: true, data: body });
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
            optionValues: { size: v.size, color: v.color },
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
              optionValues: { size: v.size, color: v.color },
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
                  optionValues: { size: v.size, color: v.color },
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
      include: { order: true, return: { select: { id: true } } },
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
      returnId: i.return?.id ?? null,
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
      // Seller-referral reward check (idempotent, no-op unless this seller was referred).
      checkSellerReferralReward(req.seller!.id).catch((err) =>
        console.error('[clowe-api] referral reward check failed:', err),
      );
    }
    res.json({ success: true, data: { id: item.id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Ads (promoted placements — admin approves; payment manual for now)
// ---------------------------------------------------------------------------

function toSellerAdRow(ad: {
  id: string;
  productId: string;
  placement: string;
  durationDays: number;
  pricePaise: number;
  status: string;
  rejectionReason: string | null;
  startAt: Date | null;
  endAt: Date | null;
  views: number;
  clicks: number;
  createdAt: Date;
  product: { title: string; slug: string; images: { url: string }[] };
}): SellerAdRow {
  return {
    id: ad.id,
    productId: ad.productId,
    productTitle: ad.product.title,
    productSlug: ad.product.slug,
    imageUrl: ad.product.images[0]?.url ?? null,
    placement: ad.placement as SellerAdRow['placement'],
    durationDays: ad.durationDays,
    pricePaise: ad.pricePaise,
    status: ad.status,
    rejectionReason: ad.rejectionReason,
    startAt: ad.startAt?.toISOString() ?? null,
    endAt: ad.endAt?.toISOString() ?? null,
    views: ad.views,
    clicks: ad.clicks,
    createdAt: ad.createdAt.toISOString(),
  };
}

// Current ad pricing (from admin settings) — shown before the seller submits.
sellerRouter.get('/ads/pricing', requireSeller, async (_req, res, next) => {
  try {
    const { adPricing } = await getSettings();
    res.json({ success: true, data: adPricing });
  } catch (err) {
    next(err);
  }
});

sellerRouter.get('/ads', requireSeller, async (req, res, next) => {
  try {
    await expireDueAds(); // keep statuses fresh for the dashboard
    const ads = await prisma.ad.findMany({
      where: { sellerId: req.seller!.id },
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { title: true, slug: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } } } },
    });
    res.json({ success: true, data: ads.map(toSellerAdRow) });
  } catch (err) {
    next(err);
  }
});

// Create an ad request for one of the seller's LIVE products.
sellerRouter.post('/ads', requireSeller, requireApprovedSeller, async (req, res, next) => {
  try {
    const input = adCreateSchema.parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: input.productId } });
    if (!product || product.sellerId !== req.seller!.id) throw ApiError.notFound('Product not found');
    if (product.status !== 'APPROVED') {
      throw ApiError.badRequest('Only live (approved) products can be advertised', 'PRODUCT_NOT_LIVE');
    }

    const { adPricing } = await getSettings();
    const pricePaise = adPricing[input.placement][String(input.durationDays) as '7' | '15' | '30'];

    const ad = await prisma.ad.create({
      data: {
        sellerId: req.seller!.id,
        productId: product.id,
        placement: input.placement,
        durationDays: input.durationDays,
        pricePaise, // snapshot — owed manually / adjusted from payouts
      },
      include: { product: { select: { title: true, slug: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } } } },
    });
    res.json({ success: true, data: toSellerAdRow(ad) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

type ReturnWithRelations = Awaited<ReturnType<typeof findSellerReturn>>;

function findSellerReturn(sellerId: string, id: string) {
  return prisma.return.findFirst({
    where: { id, orderItem: { sellerId } },
    include: {
      refund: true,
      orderItem: {
        include: {
          order: { select: { orderNumber: true, shipName: true } },
          product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
        },
      },
    },
  });
}

function toReturnRow(r: NonNullable<ReturnWithRelations>): SellerReturnRow {
  return {
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
  };
}

// Sidebar badge: returns waiting for this seller's decision.
sellerRouter.get('/returns/pending-count', requireSeller, async (req, res, next) => {
  try {
    const count = await prisma.return.count({
      where: { orderItem: { sellerId: req.seller!.id }, status: 'REQUESTED' },
    });
    res.json({ success: true, data: { count } });
  } catch (err) {
    next(err);
  }
});

// All returns for this seller's items, newest first, optional ?status= filter.
sellerRouter.get('/returns', requireSeller, async (req, res, next) => {
  try {
    const { status } = z
      .object({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED']).optional() })
      .parse(req.query);
    const returns = await prisma.return.findMany({
      where: { orderItem: { sellerId: req.seller!.id }, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        refund: true,
        orderItem: {
          include: {
            order: { select: { orderNumber: true, shipName: true } },
            product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
          },
        },
      },
    });
    res.json({ success: true, data: returns.map(toReturnRow) });
  } catch (err) {
    next(err);
  }
});

sellerRouter.get('/returns/:id', requireSeller, async (req, res, next) => {
  try {
    const r = await findSellerReturn(req.seller!.id, req.params.id);
    if (!r) throw ApiError.notFound('Return not found');
    res.json({ success: true, data: toReturnRow(r) });
  } catch (err) {
    next(err);
  }
});

// Seller decision — strict state machine:
//   approve:  REQUESTED → APPROVED (pickup gets scheduled)
//   reject:   REQUESTED → REJECTED (reason shown to customer; item back to DELIVERED)
//   received: APPROVED  → RECEIVED (+ auto refund when condition is OK)
sellerRouter.patch('/returns/:id', requireSeller, async (req, res, next) => {
  try {
    const input = sellerReturnActionSchema.parse(req.body);
    const r = await findSellerReturn(req.seller!.id, req.params.id);
    if (!r) throw ApiError.notFound('Return not found');

    const item = await prisma.orderItem.findUnique({
      where: { id: r.orderItemId },
      include: { order: { include: { user: { select: { id: true, phone: true } } } } },
    });
    if (!item) throw ApiError.notFound('Order item not found');
    const customer = item.order.user;
    const label = `"${item.title}" (${item.order.orderNumber})`;

    if (input.action === 'approve') {
      if (r.status !== 'REQUESTED') {
        throw ApiError.badRequest(`Cannot approve a return in status ${r.status}`);
      }
      await prisma.$transaction([
        prisma.return.update({
          where: { id: r.id },
          data: { status: 'APPROVED', approvedAt: new Date() },
        }),
        prisma.notification.create({
          data: {
            userId: customer.id,
            type: 'RETURN_APPROVED',
            title: 'Return approved ✅',
            body: `Your return for ${label} is approved. Pickup will be scheduled shortly — please keep the item packed.`,
          },
        }),
      ]);
      sendToUserSafe(
        customer.id,
        {
          channel: 'whatsapp',
          to: `+91${customer.phone}`,
          body: `Clowe: your return for ${label} is approved. Pickup will be scheduled shortly. ✅`,
        },
        { critical: true },
      );
    } else if (input.action === 'reject') {
      if (r.status !== 'REQUESTED') {
        throw ApiError.badRequest(`Cannot reject a return in status ${r.status}`);
      }
      await prisma.$transaction([
        prisma.return.update({
          where: { id: r.id },
          data: {
            status: 'REJECTED',
            rejectionReason: input.rejectionReason,
            rejectedAt: new Date(),
            resolvedAt: new Date(),
          },
        }),
        // The item goes back to DELIVERED (the return did not happen).
        prisma.orderItem.update({ where: { id: item.id }, data: { status: 'DELIVERED' } }),
        prisma.notification.create({
          data: {
            userId: customer.id,
            type: 'RETURN_REJECTED',
            title: 'Return request declined',
            body: `Your return for ${label} was declined: "${input.rejectionReason}". If you disagree, raise a complaint from Support and our team will review it.`,
          },
        }),
      ]);
      sendToUserSafe(
        customer.id,
        {
          channel: 'whatsapp',
          to: `+91${customer.phone}`,
          body: `Clowe: your return for ${label} was declined — ${input.rejectionReason}`,
        },
        { critical: true },
      );
    } else {
      // action === 'received'
      if (r.status !== 'APPROVED') {
        throw ApiError.badRequest(`Cannot mark received a return in status ${r.status}`);
      }
      const refundPaise = item.pricePaise * item.quantity;
      const [, , refundRecord] = await prisma.$transaction([
        prisma.return.update({
          where: { id: r.id },
          data: {
            status: 'RECEIVED',
            receivedAt: new Date(),
            receivedCondition: input.condition,
            ...(input.condition === 'DAMAGED' ? { resolvedAt: new Date() } : {}),
          },
        }),
        prisma.orderItem.update({ where: { id: item.id }, data: { status: 'RETURNED' } }),
        // Refund only when the item came back in OK condition.
        ...(input.condition === 'OK'
          ? [
              prisma.refund.create({
                data: {
                  returnId: r.id,
                  orderId: item.orderId,
                  amountPaise: refundPaise,
                  provider: paymentProvider.name,
                  status: 'PENDING',
                },
              }),
              prisma.notification.create({
                data: {
                  userId: customer.id,
                  type: 'REFUND_INITIATED',
                  title: 'Refund initiated 💰',
                  body: `We received ${label} back. Your refund of ₹${(refundPaise / 100).toFixed(2)} has been initiated — expect it within 5–7 business days.`,
                },
              }),
            ]
          : [
              prisma.notification.create({
                data: {
                  userId: customer.id,
                  type: 'RETURN_RECEIVED',
                  title: 'Return received',
                  body: `${label} reached the seller, but was flagged as damaged on arrival. Our support team will contact you — you can also raise a complaint from Support.`,
                },
              }),
            ]),
      ]);
      if (input.condition === 'OK' && refundRecord && 'returnId' in refundRecord) {
        await processRefund(refundRecord.id);
      }
    }

    const fresh = await findSellerReturn(req.seller!.id, r.id);
    res.json({ success: true, data: toReturnRow(fresh!) });
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
