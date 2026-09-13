import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import type { SellerProfile } from '@prisma/client';
import {
  MAX_VARIANT_AXES,
  optionValuesFromJson,
  variantOptionFields,
  type CategoryRules,
  adCreateSchema,
  phoneSchema,
  sellerRegisterSchema,
  sellerProductUpsertSchema,
  sellerReturnActionSchema,
  type SellerAdRow,
  type ProductAttribute,
  type SellerProductDetail,
  type SellerProductUpsertInput,
  type SellerProfileInfo,
  type SellerReferralInfo,
  type SellerReturnRow,
  type SellerStats,
} from '@clowe/shared';
import { prisma } from '../db';
import { categoryRulesFor } from '../services/categoryRules';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { applyReturnDecision, findSellerReturn } from '../services/returnService';
import { getSettings } from '../services/settingsService';
import { removeUploadByUrl } from './uploads';
import { isSensitiveForTryOn } from '../services/tryon/sensitiveGarment';
import { isListingBelowTryOnAge } from '../services/tryon/ageGate';
import { expireDueAds } from './ads';
import {
  SELLER_REFERRAL_REWARD_PAISE,
  SELLER_REFERRAL_TARGET_PAISE,
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
export async function requireSeller(req: Request, _res: Response, next: NextFunction) {
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
    // Launch offer: the first 100 shops on Clowe get 50 free AI try-ons.
    const granted = await prisma.sellerProfile.count({ where: { tryOnFreeGrant: true } });
    if (granted < 100) {
      await prisma.$transaction([
        prisma.sellerProfile.update({
          where: { id: profile.id },
          data: { tryOnFreeGrant: true, tryOnCredits: { increment: 50 } },
        }),
        prisma.tryOnCreditLedger.create({
          data: {
            sellerId: profile.id,
            delta: 50,
            reason: 'FREE_GRANT',
            note: 'Early-seller launch offer',
          },
        }),
      ]);
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
      slug: p.slug,
      categoryId: p.categoryId,
      brand: p.brand,
      brandId: p.brandId,
      shortDescription: p.shortDescription,
      description: p.description,
      status: p.status,
      rejectionReason: p.rejectionReason,
      imageUrls: p.images.map((i) => i.url),
      videoUrl: p.videoUrl,
      packingVideoUrl: p.packingVideoUrl,
      attributes: (p.attributes as ProductAttribute[] | null) ?? [],
      highlights: (p.highlights as string[] | null) ?? [],
      taxRatePercent: p.taxRatePercent,
      weightGrams: p.weightGrams,
      lengthMm: p.lengthMm,
      widthMm: p.widthMm,
      heightMm: p.heightMm,
      shippingTemplate: (p.shippingTemplate as SellerProductDetail['shippingTemplate']) ?? null,
      metaTitle: p.metaTitle,
      metaDescription: p.metaDescription,
      tags: p.tags,
      isVisible: p.isVisible,
      tryOnEnabled: p.tryOnEnabled,
      lowStockAlert: p.lowStockAlert,
      allowBackorders: p.allowBackorders,
      variants: p.variants.map((v) => ({
        id: v.id,
        size: v.size,
        color: v.color,
        optionValues: optionValuesFromJson(v.optionValues),
        label: v.label,
        sku: v.sku,
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

/** Fields shared by create and update — everything the listing form owns. */
function productDataFrom(input: SellerProductUpsertInput, rules: CategoryRules) {
  return {
    title: input.title,
    categoryId: input.categoryId,
    brand: input.brand?.trim() || null,
    brandId: input.brandId || null,
    shortDescription: input.shortDescription?.trim() || null,
    description: input.description,
    videoUrl: input.videoUrl?.trim() || null,
    packingVideoUrl: input.packingVideoUrl?.trim() || null,
    attributes: (input.attributes ?? []) as object,
    highlights: (input.highlights ?? []) as object,
    taxRatePercent: input.taxRatePercent ?? null,
    weightGrams: input.weightGrams ?? null,
    lengthMm: input.lengthMm ?? null,
    widthMm: input.widthMm ?? null,
    heightMm: input.heightMm ?? null,
    shippingTemplate: input.shippingTemplate ?? null,
    metaTitle: input.metaTitle?.trim() || null,
    metaDescription: input.metaDescription?.trim() || null,
    tags: input.tags ?? [],
    isVisible: input.isVisible ?? true,
    // Opt-in, and only honoured where the category allows try-on at all —
    // and never for innerwear, swimwear or sleepwear, whichever category the
    // seller filed the listing under.
    tryOnEnabled:
      (input.tryOnEnabled ?? false) &&
      rules.tryOnEligible &&
      !isSensitiveForTryOn(input.title) &&
      !isListingBelowTryOnAge(input.variants.map((v) => v.optionValues?.size ?? '')),
    lowStockAlert: input.lowStockAlert ?? 5,
    allowBackorders: input.allowBackorders ?? false,
  };
}

/**
 * Base price drives listing cards and the try-on threshold. A draft may have
 * no variants yet, so it falls back to 0 until one is added.
 */
function basePriceOf(input: SellerProductUpsertInput): number {
  const prices = input.variants.map((v) => v.pricePaise);
  return prices.length > 0 ? Math.min(...prices) : 0;
}

/** Variant rows with their derived columns; rejects mixed axes and duplicates. */
function variantRowsFrom(input: SellerProductUpsertInput) {
  const rows = input.variants.map((v) => ({
    input: v,
    fields: variantOptionFields(v.optionValues, [], { size: v.size, color: v.color }),
  }));
  const axisSets = new Set(rows.map((r) => Object.keys(r.fields.optionValues).sort().join('|')));
  if (axisSets.size > 1) {
    throw ApiError.badRequest(
      'Every variant must use the same options (e.g. all of them have Colour and Size)',
      'VARIANT_AXES_MISMATCH',
    );
  }
  if (rows.some((r) => Object.keys(r.fields.optionValues).length > MAX_VARIANT_AXES)) {
    throw ApiError.badRequest(
      `A product can vary on at most ${MAX_VARIANT_AXES} options`,
      'VARIANT_AXES_LIMIT',
    );
  }
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.fields.optionsKey)) {
      throw ApiError.badRequest(
        `Duplicate variant: ${r.fields.label || 'two rows with no options'}`,
        'VARIANT_DUPLICATE',
      );
    }
    seen.add(r.fields.optionsKey);
  }
  return rows;
}

/** The packing clip is part of every reviewed listing - drafts may still skip it. */
function assertPackingVideo(input: SellerProductUpsertInput) {
  if (input.mode === 'DRAFT') return;
  if (!input.packingVideoUrl?.trim()) {
    throw ApiError.badRequest(
      'Upload a short video of the product being packed before submitting for review',
      'PACKING_VIDEO_REQUIRED',
    );
  }
}

/** Spec fields the category marks required must be filled before review. */
function assertRequiredAttributes(input: SellerProductUpsertInput, rules: CategoryRules) {
  if (input.mode === 'DRAFT') return;
  const given = new Map(
    (input.attributes ?? []).map((a) => [a.name.trim().toLowerCase(), a.value.trim()]),
  );
  const missing = rules.attributeSchema
    .filter((a) => a.required && !given.get(a.label.toLowerCase()))
    .map((a) => a.label);
  if (missing.length) {
    throw ApiError.badRequest(`Please fill in: ${missing.join(', ')}`, 'ATTRIBUTES_REQUIRED');
  }
}

sellerRouter.post('/products', requireSeller, requireApprovedSeller, async (req, res, next) => {
  try {
    const input = sellerProductUpsertSchema.parse(req.body);
    const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!category) throw ApiError.badRequest('Category not found', 'CATEGORY_NOT_FOUND');
    const rules = await categoryRulesFor(category.id);
    assertRequiredAttributes(input, rules);
    assertPackingVideo(input);
    const variantRows = variantRowsFrom(input);

    const slug = `${slugify(`${input.brand ?? ''} ${input.title}`)}-${randomBytes(3).toString('hex')}`;

    const product = await prisma.product.create({
      data: {
        sellerId: req.seller!.id,
        ...productDataFrom(input, rules),
        slug,
        packingVideoUploadedAt: input.packingVideoUrl?.trim() ? new Date() : null,
        basePricePaise: basePriceOf(input),
        // Drafts stay private until the seller submits them for review.
        status: input.mode === 'DRAFT' ? 'DRAFT' : 'PENDING',
        images: {
          create: input.imageUrls.map((url, i) => ({ url, altText: input.title, sortOrder: i })),
        },
        variants: {
          create: variantRows.map(({ input: v, fields }) => ({
            ...fields,
            sku: v.sku?.trim() || newSku(),
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
    const rules = await categoryRulesFor(input.categoryId);
    assertRequiredAttributes(input, rules);
    assertPackingVideo(input);
    const variantRows = variantRowsFrom(input);

    const keptIds = input.variants.filter((v) => v.id).map((v) => v.id!);

    // A replaced or removed packing video frees its file straight away; a fresh
    // upload restarts the 10-day retention clock.
    const newPackingVideo = input.packingVideoUrl?.trim() || null;
    const videoChanged = newPackingVideo !== product.packingVideoUrl;
    if (videoChanged && product.packingVideoUrl) removeUploadByUrl(product.packingVideoUrl);

    await prisma.$transaction([
      prisma.product.update({
        where: { id: product.id },
        data: {
          ...productDataFrom(input, rules),
          ...(videoChanged
            ? { packingVideoUploadedAt: newPackingVideo ? new Date() : null }
            : {}),
          basePricePaise: basePriceOf(input),
          // Saving a draft keeps it private; submitting sends it for re-approval.
          status: input.mode === 'DRAFT' ? 'DRAFT' : 'PENDING',
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
      ...variantRows
        .filter((r) => r.input.id)
        .map(({ input: v, fields }) =>
          prisma.productVariant.update({
            where: { id: v.id! },
            data: {
              ...fields,
              ...(v.sku?.trim() ? { sku: v.sku.trim() } : {}),
              pricePaise: v.pricePaise,
              mrpPaise: v.mrpPaise ?? null,
              stock: v.stock,
            },
          }),
        ),
      ...(variantRows.some((r) => !r.input.id)
        ? [
            prisma.productVariant.createMany({
              data: variantRows
                .filter((r) => !r.input.id)
                .map(({ input: v, fields }) => ({
                  productId: product.id,
                  ...fields,
                  sku: v.sku?.trim() || newSku(),
                  pricePaise: v.pricePaise,
                  mrpPaise: v.mrpPaise ?? null,
                  stock: v.stock,
                })),
            }),
          ]
        : []),
    ]);
    res.json({
      success: true,
      data: { id: product.id, status: input.mode === 'DRAFT' ? 'DRAFT' : 'PENDING' },
    });
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


function toReturnRow(r: NonNullable<ReturnWithRelations>): SellerReturnRow {
  return {
    id: r.id,
    orderItemId: r.orderItemId,
    orderNumber: r.orderItem.order.orderNumber,
    title: r.orderItem.title,
    size: r.orderItem.size,
    color: r.orderItem.color,
    variantLabel: r.orderItem.variantLabel,
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
    const updated = await applyReturnDecision(req.seller!.id, req.params.id, input);
    res.json({ success: true, data: toReturnRow(updated) });
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
