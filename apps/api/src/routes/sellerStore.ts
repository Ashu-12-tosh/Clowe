import { Router } from 'express';
import { z } from 'zod';
import type { SellerProfile } from '@prisma/client';
import {
  WEEKDAYS,
  storeBusinessSchema,
  storeHoursSchema,
  storeProfileSchema,
  storeReturnsSchema,
  storeShippingSchema,
  type PlatformIntegration,
  type SellerStoreHealth,
  type SellerStoreOverview,
  type SellerStoreSettings,
  type StoreHealthItem,
  type StoreHighlight,
  type Weekday,
  type WorkingHours,
} from '@clowe/shared';
import { prisma } from '../db';
import { getSettings } from '../services/settingsService';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { paymentProvider } from '../services/payments';
import { shippingProvider } from '../services/shipping';
import { payoutProvider } from '../services/payouts';
import { aiProvider } from '../services/ai';
import { tryOnProvider } from '../services/tryon';
import { requireSeller } from './seller';

export const sellerStoreRouter = Router();
sellerStoreRouter.use(requireAuth, requireSeller);

const DEFAULT_HOURS: Record<Weekday, WorkingHours> = {
  mon: { open: '09:00', close: '21:00', closed: false },
  tue: { open: '09:00', close: '21:00', closed: false },
  wed: { open: '09:00', close: '21:00', closed: false },
  thu: { open: '09:00', close: '21:00', closed: false },
  fri: { open: '09:00', close: '21:00', closed: false },
  sat: { open: '09:00', close: '21:00', closed: false },
  sun: { open: '10:00', close: '18:00', closed: false },
};

const EMPTY_SOCIALS = { website: '', instagram: '', facebook: '', youtube: '' };

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parseHours(value: unknown): Record<Weekday, WorkingHours> {
  if (!value || typeof value !== 'object') return DEFAULT_HOURS;
  const raw = value as Partial<Record<Weekday, WorkingHours>>;
  return Object.fromEntries(
    WEEKDAYS.map((day) => [day, raw[day] ?? DEFAULT_HOURS[day]]),
  ) as Record<Weekday, WorkingHours>;
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
    effectiveReturnWindowDays: seller.returnWindowDays ?? (await getSettings()).returnWindowDays,
    platformReturnWindowDays: env.RETURN_WINDOW_DAYS,
    returnAddressSameAsPickup: seller.returnAddressSameAsPickup,
    returnLine1: seller.returnLine1,
    returnCity: seller.returnCity,
    returnState: seller.returnState,
    returnPincode: seller.returnPincode,

    workingHours: parseHours(seller.workingHours),
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

/**
 * What the marketplace is wired to. Read-only: these are platform-level
 * choices, not something a seller connects for their own shop.
 */
function platformIntegrations(): PlatformIntegration[] {
  const live = (name: string) => (name === 'mock' ? 'SANDBOX' : 'LIVE');
  return [
    {
      key: 'payments',
      name: paymentProvider.name,
      purpose: 'Customer payments at checkout',
      status: live(paymentProvider.name),
      detail:
        paymentProvider.name === 'mock'
          ? 'Sandbox gateway — payments are simulated in this environment'
          : 'Live gateway handling UPI, cards and netbanking',
    },
    {
      key: 'shipping',
      name: shippingProvider.name,
      purpose: 'Shipment booking and AWB generation',
      status: live(shippingProvider.name),
      detail: `Couriers available: ${shippingProvider.couriers.join(', ')}`,
    },
    {
      key: 'payouts',
      name: payoutProvider.name,
      purpose: 'Transferring your earnings to the bank',
      status: live(payoutProvider.name),
      detail:
        payoutProvider.name === 'mock'
          ? 'Sandbox payouts — transfers settle instantly with a test UTR'
          : 'Live bank transfers with UTR tracking',
    },
    {
      key: 'ai',
      name: aiProvider.name,
      purpose: 'Description writing and the seller assistant',
      status: live(aiProvider.name),
      detail:
        aiProvider.name === 'mock'
          ? 'Offline assistant grounded in the seller handbook'
          : 'Live model answering from the seller handbook',
    },
    {
      key: 'tryon',
      name: tryOnProvider.name,
      purpose: 'AI Try-On previews on your listings',
      status: live(tryOnProvider.name),
      detail:
        tryOnProvider.name === 'mock'
          ? 'Mock previews — no cost per run in this environment'
          : 'Live try-on generation',
    },
  ];
}

// ---------------------------------------------------------------------------
// GET / — settings, store strength and integrations in one call
// ---------------------------------------------------------------------------

sellerStoreRouter.get('/', async (req, res, next) => {
  try {
    const settings = await toSettings(req.seller!);
    const body: SellerStoreOverview = {
      settings,
      health: storeHealth(settings),
      integrations: platformIntegrations(),
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
    data: { settings, health: storeHealth(settings), integrations: platformIntegrations() },
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
        tagline: input.tagline?.trim() || null,
        description: input.description?.trim() || null,
        logoUrl: input.logoUrl || null,
        bannerUrl: input.bannerUrl || null,
        storeEmail: input.storeEmail || null,
        storePhone: input.storePhone?.trim() || null,
        primaryCategoryId: input.primaryCategoryId || null,
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

    if (locked) {
      const changingGst = input.gstNumber && input.gstNumber !== seller.gstNumber;
      const changingPan = input.panNumber && input.panNumber !== seller.panNumber;
      const changingPanName = input.panName && input.panName !== seller.panName;
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
        businessType: input.businessType || null,
        ...(locked
          ? {}
          : {
              gstNumber: input.gstNumber || null,
              panNumber: input.panNumber || null,
              ...(input.panName !== undefined ? { panName: input.panName || null } : {}),
            }),
        addressLine1: input.addressLine1?.trim() || null,
        addressLine2: input.addressLine2?.trim() || null,
        landmark: input.landmark?.trim() || null,
        city: input.city?.trim() || null,
        state: input.state?.trim() || null,
        pincode: input.pincode || null,
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

    if (!input.pickupSameAsBusiness && (!input.pickupLine1 || !input.pickupPincode)) {
      throw ApiError.badRequest(
        'A separate pickup address needs at least a street address and PIN code',
        'PICKUP_INCOMPLETE',
      );
    }

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        pickupSameAsBusiness: input.pickupSameAsBusiness,
        pickupName: input.pickupName?.trim() || null,
        pickupPhone: input.pickupPhone?.trim() || null,
        pickupLine1: input.pickupLine1?.trim() || null,
        pickupLine2: input.pickupLine2?.trim() || null,
        pickupCity: input.pickupCity?.trim() || null,
        pickupState: input.pickupState?.trim() || null,
        pickupPincode: input.pickupPincode || null,
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
    if (input.returnWindowDays != null && input.returnWindowDays < env.RETURN_WINDOW_DAYS) {
      throw ApiError.badRequest(
        `The marketplace guarantees ${env.RETURN_WINDOW_DAYS} days — you can extend it, not shorten it`,
        'WINDOW_TOO_SHORT',
      );
    }

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        returnWindowDays: input.returnWindowDays ?? null,
        returnAddressSameAsPickup: input.returnAddressSameAsPickup,
        returnLine1: input.returnLine1?.trim() || null,
        returnCity: input.returnCity?.trim() || null,
        returnState: input.returnState?.trim() || null,
        returnPincode: input.returnPincode || null,
      },
    });
    await respond(seller.id, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /hours — working hours and vacation mode
// ---------------------------------------------------------------------------

sellerStoreRouter.put('/hours', async (req, res, next) => {
  try {
    const seller = req.seller!;
    const input = storeHoursSchema.parse(req.body);
    const until = input.vacationUntil ? new Date(input.vacationUntil) : null;

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        workingHours: input.workingHours as object,
        vacationMode: input.vacationMode,
        vacationUntil: until && !Number.isNaN(until.getTime()) ? until : null,
        vacationMessage: input.vacationMessage?.trim() || null,
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
