import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import type { SellerProfile, SellerStatus } from '@prisma/client';
import {
  MAX_VARIANT_AXES,
  canonicalAttributes,
  missingRequiredAttributes,
  normaliseAttributes,
  optionAxisKeys,
  optionValuesFromJson,
  variantOptionFields,
  type CategoryRules,
  AD_PLACEMENT_LABELS,
  adCreateSchema,
  phoneSchema,
  sellerRegisterSchema,
  sellerProductUpsertSchema,
  sellerReturnActionSchema,
  type SellerAdRow,
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
import { spendPromotionCredits } from '../services/sellerLedgerService';
import { removeStoredFile } from './uploads';
import { assertOwnAssets, resolveFileUrl } from '../services/assets';
import { isSensitiveForTryOn } from '../services/tryon/sensitiveGarment';
import { isListingBelowTryOnAge } from '../services/tryon/ageGate';
import { expireDueAds } from './ads';
import {
  SELLER_REFERRAL_REWARD_PAISE,
  SELLER_REFERRAL_TARGET_PAISE,
  deliveredSalesPaise,
  ensureSellerReferralCode,
} from '../services/sellerReferralService';
import { withPhotoUrls } from '../services/assets';

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

/**
 * Statuses that stop a seller changing anything. REJECTED is in here with the
 * other two because a rejected application is not an account to trade from.
 */
const BLOCKED_SELLER_STATUSES = new Set<SellerStatus>(['SUSPENDED', 'BANNED', 'REJECTED']);

/**
 * Blocks writes by a seller who is suspended, banned or rejected — reads stay
 * open so they can still see their orders, their money and why they were
 * stopped.
 *
 * Keyed on the HTTP method rather than a list of routes on purpose. A route
 * added to any of these routers next month is covered without anyone
 * remembering to cover it, which is the same reason the variant write carries
 * its owner in the where clause instead of trusting a guard above it.
 *
 * Deliberately not `requireApprovedSeller`: PENDING is not suspended. A new
 * seller has to write their store profile, business details and KYC in order
 * to become approved, and demanding approval for those would lock the door
 * they are supposed to walk through.
 *
 * Not applied to the support router. Suspending someone and removing the way
 * to contest it at the same time is not a suspension, it is a dead end.
 */
export function blockSuspendedWrites(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET') return next();
  const status = req.seller!.status;
  if (BLOCKED_SELLER_STATUSES.has(status)) {
    return next(
      ApiError.forbidden(
        status === 'REJECTED'
          ? 'Your seller application was not approved, so this cannot be changed.'
          : `Your shop is ${status.toLowerCase()}, so this cannot be changed. Contact support if you think that is wrong.`,
        'SELLER_BLOCKED',
      ),
    );
  }
  next();
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
    suspensionReason: p.suspensionReason,
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
    include: {
      images: { orderBy: { sortOrder: 'asc' } },
      // The edit form needs each variant's own pictures to show them grouped,
      // and the ownership guard on PUT reads variants from here too.
      variants: { include: { images: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!product || product.sellerId !== req.seller!.id) {
    throw ApiError.notFound('Product not found');
  }
  return product;
}

sellerRouter.get('/products/:id', requireSeller, async (req, res, next) => {
  try {
    const p = await ownProduct(req, req.params.id);
    const rules = await categoryRulesFor(p.categoryId);
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
      packingVideoUrl: await resolveFileUrl(p.packingVideoUrl),
      packingVideoRef: p.packingVideoUrl,
      attributes: normaliseAttributes(p.attributes, rules.attributeSchema),
      highlights: (p.highlights as string[] | null) ?? [],
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
        imageUrls: v.images.map((i) => i.url),
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
    packingVideoUrl: input.packingVideoRef?.trim() || null,
    attributes: canonicalAttributes(input.attributes ?? [], rules.attributeSchema) as object,
    highlights: (input.highlights ?? []) as object,
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
  const axisSets = new Set(rows.map((r) => optionAxisKeys(r.fields.optionValues).sort().join('|')));
  if (axisSets.size > 1) {
    throw ApiError.badRequest(
      'Every variant must use the same options (e.g. all of them have Colour and Size)',
      'VARIANT_AXES_MISMATCH',
    );
  }
  if (rows.some((r) => optionAxisKeys(r.fields.optionValues).length > MAX_VARIANT_AXES)) {
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
  if (!input.packingVideoRef?.trim()) {
    throw ApiError.badRequest(
      'Upload a short video of the product being packed before submitting for review',
      'PACKING_VIDEO_REQUIRED',
    );
  }
}

/** Spec fields the category marks required must be filled before review. */
/**
 * Every colour must have pictures before a listing goes for review.
 *
 * A colour is the one thing the product gallery genuinely misrepresents — a
 * Navy jacket shown in Black photos is wrong in a way a size never is. So the
 * requirement is scoped to listings that vary on colour; a product that only
 * varies on size keeps using the product gallery, which is already mandatory
 * to submit and so can never be empty.
 *
 * This cannot live in the Zod schema, and the reason is worth stating: an
 * absent `imageUrls` means "leave the stored pictures alone", so the payload
 * on its own does not say whether a variant has images. Only the route knows,
 * because only the route has loaded what is stored. `stored` is empty on
 * create, where the payload is the whole truth.
 */
function assertVariantImages(
  input: SellerProductUpsertInput,
  stored: Map<string, number>,
) {
  if (input.mode !== 'SUBMIT') return; // a draft may be half-finished
  const colourKeyOf = (v: SellerProductUpsertInput['variants'][number]) =>
    Object.keys(v.optionValues ?? {}).find((k) => /colou?r/i.test(k));
  const colourKey = input.variants.map(colourKeyOf).find(Boolean);
  if (!colourKey) return; // no colour axis — the product gallery is the answer

  const missing = new Set<string>();
  for (const v of input.variants) {
    const colour = (v.optionValues?.[colourKey] ?? '').trim();
    if (!colour) continue;
    // Payload wins when present; otherwise fall back to what is stored.
    const count = v.imageUrls !== undefined ? v.imageUrls.length : (v.id ? (stored.get(v.id) ?? 0) : 0);
    if (count === 0) missing.add(colour);
  }
  if (missing.size > 0) {
    throw ApiError.badRequest(
      `Add at least one image for ${[...missing].join(', ')} — each colour needs its own pictures`,
      'VARIANT_IMAGES_REQUIRED',
    );
  }
}

function assertRequiredAttributes(input: SellerProductUpsertInput, rules: CategoryRules) {
  if (input.mode === 'DRAFT') return;
  // Matched by key once canonical, so "fabric", "Fabric" and a row that
  // arrived with the rule's key all count as the same field.
  const missing = missingRequiredAttributes(
    canonicalAttributes(input.attributes ?? [], rules.attributeSchema),
    rules.attributeSchema,
  );
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
    assertVariantImages(input, new Map());
    const variantRows = variantRowsFrom(input);

    const slug = `${slugify(`${input.brand ?? ''} ${input.title}`)}-${randomBytes(3).toString('hex')}`;
    // The packing clip must be this seller's own upload.
    if (input.packingVideoRef?.trim()) {
      await assertOwnAssets([input.packingVideoRef.trim()], { ownerId: req.auth!.userId, purpose: 'PACKING_VIDEO' });
    }

    const product = await prisma.product.create({
      data: {
        sellerId: req.seller!.id,
        ...productDataFrom(input, rules),
        slug,
        packingVideoUploadedAt: input.packingVideoRef?.trim() ? new Date() : null,
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
            ...(v.imageUrls?.length
              ? {
                  images: {
                    create: v.imageUrls.map((url, i) => ({
                      url,
                      altText: input.title,
                      sortOrder: i,
                    })),
                  },
                }
              : {}),
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
    assertVariantImages(
      input,
      new Map(product.variants.map((v) => [v.id, v.images.length])),
    );
    const variantRows = variantRowsFrom(input);

    const keptIds = input.variants.filter((v) => v.id).map((v) => v.id!);

    // Owning the product is not the same as owning the variant. Variant ids
    // arrive in the request body, and every one of them is public — the
    // storefront returns them on the product page so the cart can reference
    // them — so a seller could otherwise put a rival's variant id in a request
    // against their own product and rewrite that variant's price, stock or SKU.
    // Refused rather than quietly skipped, so a client holding a stale variant
    // is told instead of believing an edit landed.
    const ownVariantIds = new Set(product.variants.map((v) => v.id));
    const foreignIds = keptIds.filter((id) => !ownVariantIds.has(id));
    if (foreignIds.length > 0) {
      throw ApiError.notFound(
        'One of those variants does not belong to this product',
        'VARIANT_NOT_ON_PRODUCT',
      );
    }

    // A replaced or removed packing video frees its file straight away; a fresh
    // upload restarts the 10-day retention clock.
    const newPackingVideo = input.packingVideoRef?.trim() || null;
    const videoChanged = newPackingVideo !== product.packingVideoUrl;
    if (videoChanged && newPackingVideo) {
      await assertOwnAssets([newPackingVideo], { ownerId: req.auth!.userId, purpose: 'PACKING_VIDEO' });
    }

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
          // updateMany rather than update, so the productId sits in the where
          // clause: a variant belonging to another product matches nothing and
          // is written to zero times, even if the guard above is ever lost in a
          // refactor. This is the same scoping the deleteMany above already has.
          prisma.productVariant.updateMany({
            where: { id: v.id!, productId: product.id },
            data: {
              ...fields,
              ...(v.sku?.trim() ? { sku: v.sku.trim() } : {}),
              pricePaise: v.pricePaise,
              mrpPaise: v.mrpPaise ?? null,
              stock: v.stock,
            },
          }),
        ),
      // Variant images, only for the variants whose set the form actually sent.
      // An omitted imageUrls leaves the rows alone, which is what stops an
      // unrelated edit — a price change, a re-colour — from wiping pictures.
      //
      // Both halves are scoped independently of the guard above. The guard
      // already rejects a foreign id, so this is belt and braces — but the
      // cross-seller write this file was fixed for happened exactly because a
      // delete carried the constraint and the write beside it did not, and a
      // pair that is only safe while some earlier check survives is the same
      // arrangement wearing a different hat.
      ...variantRows
        .filter(
          (r) => r.input.id && ownVariantIds.has(r.input.id) && r.input.imageUrls !== undefined,
        )
        .flatMap(({ input: v }) => [
          prisma.productVariantImage.deleteMany({
            where: { variantId: v.id!, variant: { productId: product.id } },
          }),
          prisma.productVariantImage.createMany({
            data: (v.imageUrls ?? []).map((url, i) => ({
              variantId: v.id!,
              url,
              altText: input.title,
              sortOrder: i,
            })),
          }),
        ]),
      // New variants are created one at a time rather than with createMany, so
      // each can carry its own images in the same write — createMany cannot do
      // nested creates, and the ids do not exist yet to attach them afterwards.
      ...variantRows
        .filter((r) => !r.input.id)
        .map(({ input: v, fields }) =>
          prisma.productVariant.create({
            data: {
              productId: product.id,
              ...fields,
              sku: v.sku?.trim() || newSku(),
              pricePaise: v.pricePaise,
              mrpPaise: v.mrpPaise ?? null,
              stock: v.stock,
              ...(v.imageUrls?.length
                ? {
                    images: {
                      create: v.imageUrls.map((url, i) => ({
                        url,
                        altText: input.title,
                        sortOrder: i,
                      })),
                    },
                  }
                : {}),
            },
          }),
        ),
    ]);
    // Only once the listing points at the new clip is the old one freed.
    if (videoChanged && product.packingVideoUrl) await removeStoredFile(product.packingVideoUrl);
    res.json({
      success: true,
      data: { id: product.id, status: input.mode === 'DRAFT' ? 'DRAFT' : 'PENDING' },
    });
  } catch (err) {
    next(err);
  }
});

// Archive (soft delete) a product.
sellerRouter.delete('/products/:id', requireSeller, blockSuspendedWrites, async (req, res, next) => {
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

    // Paid up front from promotion credits, in the same transaction as the
    // booking: either the ad exists and its credits are spent, or neither.
    const ad = await prisma.$transaction(async (tx) => {
      const created = await tx.ad.create({
        data: {
          sellerId: req.seller!.id,
          productId: product.id,
          placement: input.placement,
          durationDays: input.durationDays,
          pricePaise, // snapshot of admin pricing at booking
        },
        include: { product: { select: { title: true, slug: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } } } },
      });
      await spendPromotionCredits(
        tx,
        req.seller!.id,
        pricePaise,
        created.id,
        `${AD_PLACEMENT_LABELS[input.placement]} · ${input.durationDays} days · "${product.title}"`,
      );
      return created;
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
    res.json({ success: true, data: await withPhotoUrls(returns.map(toReturnRow)) });
  } catch (err) {
    next(err);
  }
});

sellerRouter.get('/returns/:id', requireSeller, async (req, res, next) => {
  try {
    const r = await findSellerReturn(req.seller!.id, req.params.id);
    if (!r) throw ApiError.notFound('Return not found');
    res.json({ success: true, data: (await withPhotoUrls([toReturnRow(r)]))[0] });
  } catch (err) {
    next(err);
  }
});

// Seller decision — strict state machine:
//   approve:  REQUESTED → APPROVED (pickup gets scheduled)
//   reject:   REQUESTED → REJECTED (reason shown to customer; item back to DELIVERED)
//   received: APPROVED  → RECEIVED (+ auto refund when condition is OK)
sellerRouter.patch('/returns/:id', requireSeller, blockSuspendedWrites, async (req, res, next) => {
  try {
    const input = sellerReturnActionSchema.parse(req.body);
    const updated = await applyReturnDecision(req.seller!.id, req.params.id, input);
    res.json({ success: true, data: (await withPhotoUrls([toReturnRow(updated)]))[0] });
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
