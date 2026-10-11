import { Router } from 'express';
import { z } from 'zod';
import type { SellerProfile } from '@prisma/client';
import {
  storeBusinessSchema,
  storeVacationSchema,
  storeProfileSchema,
  storeReturnsSchema,
  storeShippingSchema,
  type SellerStoreHealth,
  type SellerStoreOverview,
  type SellerStoreSettings,
  type StoreHealthItem,
  type StoreHighlight,
} from '@clowe/shared';
import { prisma } from '../db';
import { getSettings } from '../services/settingsService';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { blockSuspendedWrites, requireSeller } from './seller';

export const sellerStoreRouter = Router();
sellerStoreRouter.use(requireAuth, requireSeller, blockSuspendedWrites);

const EMPTY_SOCIALS = { website: '', instagram: '', facebook: '', youtube: '' };

/**
 * One optional text field of a section save. Absent is not empty: undefined
 * leaves the stored value alone (Prisma skips undefined), "" clears it, and
 * anything else is saved trimmed. The settings form always sends every field
 * of the section, as "" when blank, so clearing from the page still works; a
 * client that sends only what it changed no longer wipes the rest.
 */
function fieldUpdate(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const v = value?.trim();
  return v ? v : null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parseSocials(value: unknown): SellerStoreSettings['socialLinks'] {
  if (!value || typeof value !== 'object') return { ...EMPTY_SOCIALS };
  return { ...EMPTY_SOCIALS, ...(value as Record<string, string>) };
}

function parseHighlights(value: unknown): StoreHighlight[] {
  if (!Array.isArray(value)) return [];
  return (value as StoreHighlight[]).filter(
    (h) => h && typeof h.title === 'string' && typeof h.icon === 'string',
  );
}

async function toSettings(seller: SellerProfile): Promise<SellerStoreSettings> {
  const platformWindowDays = (await getSettings()).returnWindowDays;
  const [category, counts, methodCount] = await Promise.all([
    seller.primaryCategoryId
      ? prisma.category.findUnique({
          where: { id: seller.primaryCategoryId },
          select: { name: true },
        })
      : Promise.resolve(null),
    prisma.product.groupBy({
      by: ['status'],
      where: { sellerId: seller.id, status: { not: 'ARCHIVED' } },
      _count: { _all: true },
    }),
    prisma.sellerPayoutMethod.count({ where: { sellerId: seller.id } }),
  ]);

  const productCount = counts.reduce((sum, c) => sum + c._count._all, 0);
  const liveProductCount = counts.find((c) => c.status === 'APPROVED')?._count._all ?? 0;

  return {
    id: seller.id,
    shopName: seller.shopName,
    slug: seller.slug,
    storeUrl: seller.slug ? `/store/${seller.slug}` : null,
    tagline: seller.tagline,
    description: seller.description,
    logoUrl: seller.logoUrl,
    bannerUrl: seller.bannerUrl,
    storeEmail: seller.storeEmail,
    storePhone: seller.storePhone,
    highlights: parseHighlights(seller.highlights),
    socialLinks: parseSocials(seller.socialLinks),
    primaryCategoryId: seller.primaryCategoryId,
    primaryCategoryName: category?.name ?? null,

    businessType: seller.businessType,
    gstNumber: seller.gstNumber,
    panNumber: seller.panNumber,
    panName: seller.panName,
    addressLine1: seller.addressLine1,
    addressLine2: seller.addressLine2,
    landmark: seller.landmark,
    city: seller.city,
    state: seller.state,
    pincode: seller.pincode,

    bankName: seller.bankName,
    bankAccountName: seller.bankAccountName,
    // Only the tail of the account number ever leaves the server.
    bankAccountLast4: seller.bankAccountNo ? seller.bankAccountNo.slice(-4) : null,
    bankIfsc: seller.bankIfsc,
    payoutMethodCount: methodCount,

    pickupSameAsBusiness: seller.pickupSameAsBusiness,
    pickupName: seller.pickupName,
    pickupPhone: seller.pickupPhone,
    pickupLine1: seller.pickupLine1,
    pickupLine2: seller.pickupLine2,
    pickupCity: seller.pickupCity,
    pickupState: seller.pickupState,
    pickupPincode: seller.pickupPincode,
    dispatchDays: seller.dispatchDays,
    codEnabled: seller.codEnabled,

    returnWindowDays: seller.returnWindowDays,
    effectiveReturnWindowDays: seller.returnWindowDays ?? platformWindowDays,
    platformReturnWindowDays: platformWindowDays,
    returnAddressSameAsPickup: seller.returnAddressSameAsPickup,
    returnLine1: seller.returnLine1,
    returnCity: seller.returnCity,
    returnState: seller.returnState,
    returnPincode: seller.returnPincode,

    vacationMode: seller.vacationMode,
    vacationUntil: seller.vacationUntil?.toISOString() ?? null,
    vacationMessage: seller.vacationMessage,

    status: seller.status,
    kycStatus: seller.kycStatus,
    productCount,
    liveProductCount,
  };
}

/** Store strength: what is actually filled in, and what fixing it needs. */
function storeHealth(s: SellerStoreSettings): SellerStoreHealth {
  const items: StoreHealthItem[] = [
    {
      key: 'profile',
      label: 'Store name & description',
      done: !!s.description && s.description.length >= 40,
      hint: 'Write at least 40 characters describing what you sell',
      tab: 'PROFILE',
    },
    {
      key: 'slug',
      label: 'Store URL',
      done: !!s.slug,
      hint: 'Claim a short store link customers can share',
      tab: 'PROFILE',
    },
    {
      key: 'logo',
      label: 'Logo & banner',
      done: !!s.logoUrl && !!s.bannerUrl,
      hint: 'Upload both — the banner is the first thing shoppers see',
      tab: 'PROFILE',
    },
    {
      key: 'contact',
      label: 'Store contact details',
      done: !!s.storeEmail && !!s.storePhone,
      hint: 'Add a support email and phone number',
      tab: 'PROFILE',
    },
    {
      key: 'highlights',
      label: 'Store highlights',
      done: s.highlights.length >= 3,
      hint: 'Add at least three trust chips to your store page',
      tab: 'PROFILE',
    },
    {
      key: 'business',
      label: 'Business address',
      done: !!s.addressLine1 && !!s.city && !!s.state && !!s.pincode,
      hint: 'Complete your registered address',
      tab: 'BUSINESS',
    },
    {
      key: 'tax',
      label: 'GSTIN & PAN',
      done: !!s.gstNumber && !!s.panNumber,
      hint: 'Needed for tax invoices and TDS',
      tab: 'BUSINESS',
    },
    {
      key: 'kyc',
      label: 'KYC verified',
      done: s.kycStatus === 'VERIFIED',
      hint: 'Submit documents — the admin reviews and verifies your shop',
      tab: 'BUSINESS',
    },
    {
      key: 'payout',
      label: 'Payout method',
      done: s.payoutMethodCount > 0,
      hint: 'Add a verified bank account or UPI ID to get paid',
      tab: 'BANK',
    },
    {
      key: 'pickup',
      label: 'Pickup address',
      done: s.pickupSameAsBusiness
        ? !!s.addressLine1 && !!s.pincode
        : !!s.pickupLine1 && !!s.pickupPincode,
      hint: 'Couriers collect from here and it prints on your labels',
      tab: 'SHIPPING',
    },
    {
      key: 'products',
      label: 'Products listed',
      done: s.liveProductCount > 0,
      hint: 'Publish at least one product',
      tab: 'PROFILE',
    },
  ];

  const done = items.filter((i) => i.done).length;
  const score = Math.round((done / items.length) * 100);
  return {
    score,
    rating: score >= 90 ? 'EXCELLENT' : score >= 65 ? 'GOOD' : 'NEEDS_WORK',
    items,
  };
}

// ---------------------------------------------------------------------------
// GET / — settings and store strength in one call
// ---------------------------------------------------------------------------

sellerStoreRouter.get('/', async (req, res, next) => {
  try {
    const settings = await toSettings(req.seller!);
    const body: SellerStoreOverview = {
      settings,
      health: storeHealth(settings),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

async function respond(sellerId: string, res: import('express').Response) {
  const fresh = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } });
  const settings = await toSettings(fresh);
  res.json({
    success: true,
    data: { settings, health: storeHealth(settings) },
  });
}

// ---------------------------------------------------------------------------
// PUT /profile — storefront presentation
// ---------------------------------------------------------------------------

sellerStoreRouter.put('/profile', async (req, res, next) => {
  try {
    const seller = req.seller!;
    const input = storeProfileSchema.parse(req.body);

    // A store URL must be unique across the marketplace.
    let slug = input.slug ? slugify(input.slug) : seller.slug;
    if (!slug) slug = slugify(input.shopName);
    if (slug !== seller.slug) {
      const clash = await prisma.sellerProfile.findFirst({
        where: { slug, id: { not: seller.id } },
        select: { id: true },
      });
      if (clash) throw ApiError.badRequest('That store URL is already taken', 'SLUG_TAKEN');
    }

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        shopName: input.shopName,
        slug,
        tagline: fieldUpdate(input.tagline),
        description: fieldUpdate(input.description),
        logoUrl: fieldUpdate(input.logoUrl),
        bannerUrl: fieldUpdate(input.bannerUrl),
        storeEmail: fieldUpdate(input.storeEmail),
        storePhone: fieldUpdate(input.storePhone),
        primaryCategoryId: fieldUpdate(input.primaryCategoryId),
        ...(input.highlights ? { highlights: input.highlights as object } : {}),
        ...(input.socialLinks ? { socialLinks: input.socialLinks as object } : {}),
      },
    });
    await respond(seller.id, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /business — registered details. Verified tax IDs are locked.
// ---------------------------------------------------------------------------

sellerStoreRouter.put('/business', async (req, res, next) => {
  try {
    const seller = req.seller!;
    const input = storeBusinessSchema.parse(req.body);
    const locked = seller.kycStatus === 'VERIFIED';
    // The lock protects what was verified. A PAN that was never on file can
    // still be added: payouts wait for one, so a seller approved without it
    // must have a way to supply it.
    const addingPan = locked && !seller.panNumber && !!input.panNumber;
    const addingPanName = locked && !seller.panName && !!input.panName;

    if (locked) {
      const changingGst = input.gstNumber && input.gstNumber !== seller.gstNumber;
      const changingPan = input.panNumber && input.panNumber !== seller.panNumber && !addingPan;
      const changingPanName = input.panName && input.panName !== seller.panName && !addingPanName;
      if (changingGst || changingPan || changingPanName) {
        throw ApiError.badRequest(
          'GSTIN and PAN details are locked after verification — raise a support ticket to change them',
          'KYC_LOCKED',
        );
      }
    }

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        businessType: fieldUpdate(input.businessType),
        ...(locked
          ? {
              ...(addingPan ? { panNumber: input.panNumber } : {}),
              ...(addingPanName ? { panName: input.panName } : {}),
            }
          : {
              // Payouts and every tax invoice depend on the GSTIN: never wiped by omission.
              gstNumber: fieldUpdate(input.gstNumber),
              panNumber: fieldUpdate(input.panNumber),
              panName: fieldUpdate(input.panName),
            }),
        addressLine1: fieldUpdate(input.addressLine1),
        addressLine2: fieldUpdate(input.addressLine2),
        landmark: fieldUpdate(input.landmark),
        city: fieldUpdate(input.city),
        state: fieldUpdate(input.state),
        pincode: fieldUpdate(input.pincode),
        // Editing documents after a rejection puts the shop back in the queue.
        ...(seller.kycStatus === 'REJECTED' ? { kycStatus: 'UNDER_REVIEW' as const } : {}),
      },
    });
    await respond(seller.id, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /shipping — pickup address and fulfilment preferences
// ---------------------------------------------------------------------------

sellerStoreRouter.put('/shipping', async (req, res, next) => {
  try {
    const seller = req.seller!;
    const input = storeShippingSchema.parse(req.body);

    // Judge the address as it will be saved: an omitted field keeps the stored one.
    const pickupLine1 = input.pickupLine1 === undefined ? seller.pickupLine1 : input.pickupLine1?.trim();
    const pickupPincode = input.pickupPincode === undefined ? seller.pickupPincode : input.pickupPincode?.trim();
    if (!input.pickupSameAsBusiness && (!pickupLine1 || !pickupPincode)) {
      throw ApiError.badRequest(
        'A separate pickup address needs at least a street address and PIN code',
        'PICKUP_INCOMPLETE',
      );
    }

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        pickupSameAsBusiness: input.pickupSameAsBusiness,
        pickupName: fieldUpdate(input.pickupName),
        pickupPhone: fieldUpdate(input.pickupPhone),
        pickupLine1: fieldUpdate(input.pickupLine1),
        pickupLine2: fieldUpdate(input.pickupLine2),
        pickupCity: fieldUpdate(input.pickupCity),
        pickupState: fieldUpdate(input.pickupState),
        pickupPincode: fieldUpdate(input.pickupPincode),
        dispatchDays: input.dispatchDays,
        codEnabled: input.codEnabled,
      },
    });
    await respond(seller.id, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /returns — window and return address
// ---------------------------------------------------------------------------

sellerStoreRouter.put('/returns', async (req, res, next) => {
  try {
    const seller = req.seller!;
    const input = storeReturnsSchema.parse(req.body);

    // A seller may be more generous than the platform, never stricter.
    const platformWindowDays = (await getSettings()).returnWindowDays;
    if (input.returnWindowDays != null && input.returnWindowDays < platformWindowDays) {
      throw ApiError.badRequest(
        `The marketplace guarantees ${platformWindowDays} days — you can extend it, not shorten it`,
        'WINDOW_TOO_SHORT',
      );
    }

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        // Absent keeps the shop's window; null sets it back to the platform default.
        returnWindowDays: input.returnWindowDays,
        returnAddressSameAsPickup: input.returnAddressSameAsPickup,
        returnLine1: fieldUpdate(input.returnLine1),
        returnCity: fieldUpdate(input.returnCity),
        returnState: fieldUpdate(input.returnState),
        returnPincode: fieldUpdate(input.returnPincode),
      },
    });
    await respond(seller.id, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /vacation — vacation mode (working hours stay stored, untouched)
// ---------------------------------------------------------------------------

sellerStoreRouter.put('/vacation', async (req, res, next) => {
  try {
    const seller = req.seller!;
    const input = storeVacationSchema.parse(req.body);
    const until = input.vacationUntil ? new Date(input.vacationUntil) : null;
    // Vacation stops the late-dispatch penalty clock; record for how long.
    const now = new Date();
    const vacationStamps = input.vacationMode && !seller.vacationMode
      ? { vacationStartedAt: now, vacationEndedAt: null }
      : !input.vacationMode && seller.vacationMode
        ? { vacationEndedAt: now }
        : {};

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        vacationMode: input.vacationMode,
        ...vacationStamps,
        vacationUntil:
          input.vacationUntil === undefined ? undefined : until && !Number.isNaN(until.getTime()) ? until : null,
        vacationMessage: fieldUpdate(input.vacationMessage),
      },
    });
    await respond(seller.id, res);
  } catch (err) {
    next(err);
  }
});

/** Is this store URL free? Used by the profile form as you type. */
sellerStoreRouter.get('/slug-available', async (req, res, next) => {
  try {
    const { slug } = z.object({ slug: z.string().trim().min(3).max(60) }).parse(req.query);
    const candidate = slugify(slug);
    const clash = await prisma.sellerProfile.findFirst({
      where: { slug: candidate, id: { not: req.seller!.id } },
      select: { id: true },
    });
    res.json({ success: true, data: { slug: candidate, available: !clash } });
  } catch (err) {
    next(err);
  }
});
