import {
  DEFAULT_KYC_NAME_MATCH_MIN_SCORE,
  DEFAULT_LEGAL_ENTITY,
  type PlatformSettings,
  type PublicSettings,
} from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';

/** Defaults — a key missing from the DB falls back to these. */
export const DEFAULT_SETTINGS: PlatformSettings = {
  tryonMinPricePaise: 200000, // ₹2,000
  tryonEnabled: true,
  tryonDailyLimit: env.TRYON_DAILY_LIMIT,
  tryonMonthlyBudgetPaise: 0, // unlimited
  payoutCommissionPercent: 10,
  payoutGatewayPercent: 2,
  // s.194-O: 0.1% since 1.10.2024 (Finance (No. 2) Act 2024, s.61); s.393(1)
  // Sl. 8(v) of the Income-tax Act 2025 from 1.4.2026, same rate.
  payoutTdsPercent: 0.1,
  // s.52 CGST Act: 0.5% since 10.07.2024 (Notification 15/2024-Central Tax).
  gstTcsPercent: 0.5,
  payoutMinPaise: 100000, // ₹1,000
  // How long a delivered line's earnings wait before they can be paid out.
  // Its own setting: it must cover the return window (a line with a return
  // requested leaves DELIVERED and is never paid anyway), and 7 also covers
  // lines sold under the earlier 7-day window.
  payoutHoldDays: 7,
  // The dispatch promise sellers are asked to meet, and the later point at
  // which an order not yet dispatched is charged the penalty, once.
  dispatchSlaHours: 18,
  lateDispatchPenaltyAfterHours: 24,
  lateDispatchPenaltyPaise: 8000, // ₹80 per order
  // Set to the moment it ran by migration 20261010120000; null = every order.
  lateDispatchPenaltyEffectiveFrom: null,
  penaltyEnabled: true,
  // GST 2.0, Notification 9/2025-Central Tax (Rate), in force 22.09.2025.
  gstMeritPercent: 5,
  gstStandardPercent: 18,
  gstValueSlabThresholdPaise: 250000, // ₹2,500 per piece / pair, ex-GST
  // Null: the category rules above apply. The owner's flat 18% is applied by
  // prisma/applyFlatGst.ts (after its dry run), which stores it as a setting.
  gstUniformPercent: null,
  platformFeePaise: 900, // ₹9 per line
  deliveryFeePaise: 6000, // ₹60 per shipment
  closingFeePaise: 2000, // ₹20 per unit — placeholder
  gtChargePaise: 3000, // ₹30 per unit — goods transfer
  // The platform return window, in days from delivery. The one source every
  // page reads (product pages, help, policies, seller panels); a category or
  // a seller may set its own, and each order line keeps the window it was
  // sold with.
  returnWindowDays: 5,
  auditRetentionDays: 365,
  kycNameMatchMinScore: DEFAULT_KYC_NAME_MATCH_MIN_SCORE,
  // Off. Coupons are built and seeded but not offered; flipping this to true
  // — here or from admin settings — brings the whole feature back with no
  // other change.
  couponsEnabled: false,
  // Off until there is an FSSAI licence: Grocery and Supplements are hidden,
  // not deleted. See services/foodCategories.ts.
  foodCategoriesEnabled: false,
  // The registered name is set; the rest is filled in from admin settings.
  legalEntity: DEFAULT_LEGAL_ENTITY,
  socialLinks: {
    facebook: 'https://www.facebook.com/profile.php?id=61594554615215',
    twitter: '',
    instagram: 'https://www.instagram.com/cloweshop/',
    linkedin: 'https://www.linkedin.com/company/clowe-shop/',
  },
  supportEmails: {
    customer: 'customer-support@cloweshop.com',
    vendor: 'vendor-support@cloweshop.com',
  },
  codMaxOrderPaise: 500000, // ₹5,000
  adPricing: {
    HOME_BANNER: { '7': 49900, '15': 89900, '30': 149900 },
    CATEGORY_SPONSORED: { '7': 29900, '15': 49900, '30': 79900 },
  },
  pdpOffers: [
    {
      label: 'Bank Offer',
      text: '10% instant discount on HDFC Bank credit cards',
      terms: 'Applied by the bank at payment. Min order ₹2,000, max discount ₹1,000.',
    },
    {
      label: 'No Cost EMI',
      text: 'No Cost EMI on orders above ₹3,000',
      terms: 'Available on select cards at the payment step.',
    },
    {
      label: 'Partner Offer',
      text: 'Get ₹100 cashback on your first UPI payment',
      terms: 'Credited to your UPI app within 7 days.',
    },
  ],
};

/** Full settings: DB rows merged over defaults. */
export async function getSettings(): Promise<PlatformSettings> {
  const rows = await prisma.platformSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    tryonMinPricePaise:
      (byKey.get('tryonMinPricePaise') as number | undefined) ?? DEFAULT_SETTINGS.tryonMinPricePaise,
    tryonEnabled: (byKey.get('tryonEnabled') as boolean | undefined) ?? DEFAULT_SETTINGS.tryonEnabled,
    tryonDailyLimit:
      (byKey.get('tryonDailyLimit') as number | undefined) ?? DEFAULT_SETTINGS.tryonDailyLimit,
    tryonMonthlyBudgetPaise:
      (byKey.get('tryonMonthlyBudgetPaise') as number | undefined) ??
      DEFAULT_SETTINGS.tryonMonthlyBudgetPaise,
    payoutCommissionPercent:
      (byKey.get('payoutCommissionPercent') as number | undefined) ??
      DEFAULT_SETTINGS.payoutCommissionPercent,
    payoutGatewayPercent:
      (byKey.get('payoutGatewayPercent') as number | undefined) ??
      DEFAULT_SETTINGS.payoutGatewayPercent,
    payoutTdsPercent:
      (byKey.get('payoutTdsPercent') as number | undefined) ?? DEFAULT_SETTINGS.payoutTdsPercent,
    gstTcsPercent:
      (byKey.get('gstTcsPercent') as number | undefined) ?? DEFAULT_SETTINGS.gstTcsPercent,
    payoutMinPaise:
      (byKey.get('payoutMinPaise') as number | undefined) ?? DEFAULT_SETTINGS.payoutMinPaise,
    payoutHoldDays:
      (byKey.get('payoutHoldDays') as number | undefined) ?? DEFAULT_SETTINGS.payoutHoldDays,
    dispatchSlaHours:
      (byKey.get('dispatchSlaHours') as number | undefined) ?? DEFAULT_SETTINGS.dispatchSlaHours,
    lateDispatchPenaltyAfterHours:
      (byKey.get('lateDispatchPenaltyAfterHours') as number | undefined) ??
      DEFAULT_SETTINGS.lateDispatchPenaltyAfterHours,
    lateDispatchPenaltyEffectiveFrom:
      (byKey.get('lateDispatchPenaltyEffectiveFrom') as string | null | undefined) ??
      DEFAULT_SETTINGS.lateDispatchPenaltyEffectiveFrom,
    lateDispatchPenaltyPaise:
      (byKey.get('lateDispatchPenaltyPaise') as number | undefined) ??
      DEFAULT_SETTINGS.lateDispatchPenaltyPaise,
    penaltyEnabled:
      (byKey.get('penaltyEnabled') as boolean | undefined) ?? DEFAULT_SETTINGS.penaltyEnabled,
    gstMeritPercent:
      (byKey.get('gstMeritPercent') as number | undefined) ?? DEFAULT_SETTINGS.gstMeritPercent,
    gstStandardPercent:
      (byKey.get('gstStandardPercent') as number | undefined) ?? DEFAULT_SETTINGS.gstStandardPercent,
    gstValueSlabThresholdPaise:
      (byKey.get('gstValueSlabThresholdPaise') as number | undefined) ??
      DEFAULT_SETTINGS.gstValueSlabThresholdPaise,
    gstUniformPercent:
      (byKey.get('gstUniformPercent') as number | null | undefined) ?? DEFAULT_SETTINGS.gstUniformPercent,
    platformFeePaise:
      (byKey.get('platformFeePaise') as number | undefined) ?? DEFAULT_SETTINGS.platformFeePaise,
    deliveryFeePaise:
      (byKey.get('deliveryFeePaise') as number | undefined) ?? DEFAULT_SETTINGS.deliveryFeePaise,
    closingFeePaise:
      (byKey.get('closingFeePaise') as number | undefined) ?? DEFAULT_SETTINGS.closingFeePaise,
    gtChargePaise: (byKey.get('gtChargePaise') as number | undefined) ?? DEFAULT_SETTINGS.gtChargePaise,
    returnWindowDays:
      (byKey.get('returnWindowDays') as number | undefined) ?? DEFAULT_SETTINGS.returnWindowDays,
    auditRetentionDays:
      (byKey.get('auditRetentionDays') as number | undefined) ??
      DEFAULT_SETTINGS.auditRetentionDays,
    kycNameMatchMinScore:
      (byKey.get('kycNameMatchMinScore') as number | undefined) ??
      DEFAULT_SETTINGS.kycNameMatchMinScore,
    couponsEnabled:
      (byKey.get('couponsEnabled') as boolean | undefined) ?? DEFAULT_SETTINGS.couponsEnabled,
    foodCategoriesEnabled:
      (byKey.get('foodCategoriesEnabled') as boolean | undefined) ??
      DEFAULT_SETTINGS.foodCategoriesEnabled,
    // Merged like socialLinks, so a field added later comes back with its default.
    legalEntity: {
      ...DEFAULT_SETTINGS.legalEntity,
      ...((byKey.get('legalEntity') as Partial<PlatformSettings['legalEntity']> | undefined) ?? {}),
    },
    // Merged, not replaced: a value saved before a network was added to the
    // shape would otherwise come back without it.
    socialLinks: {
      ...DEFAULT_SETTINGS.socialLinks,
      ...((byKey.get('socialLinks') as Partial<PlatformSettings['socialLinks']> | undefined) ?? {}),
    },
    supportEmails: {
      ...DEFAULT_SETTINGS.supportEmails,
      ...((byKey.get('supportEmails') as Partial<PlatformSettings['supportEmails']> | undefined) ?? {}),
    },
    codMaxOrderPaise:
      (byKey.get('codMaxOrderPaise') as number | undefined) ?? DEFAULT_SETTINGS.codMaxOrderPaise,
    adPricing:
      (byKey.get('adPricing') as PlatformSettings['adPricing'] | undefined) ??
      DEFAULT_SETTINGS.adPricing,
    pdpOffers:
      (byKey.get('pdpOffers') as PlatformSettings['pdpOffers'] | undefined) ??
      DEFAULT_SETTINGS.pdpOffers,
  };
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const s = await getSettings();
  return {
    tryonMinPricePaise: s.tryonMinPricePaise,
    dispatchSlaHours: s.dispatchSlaHours,
    lateDispatchPenaltyAfterHours: s.lateDispatchPenaltyAfterHours,
    lateDispatchPenaltyPaise: s.lateDispatchPenaltyPaise,
    penaltyEnabled: s.penaltyEnabled,
    socialLinks: s.socialLinks,
    supportEmails: s.supportEmails,
    codMaxOrderPaise: s.codMaxOrderPaise,
    pdpOffers: s.pdpOffers,
    couponsEnabled: s.couponsEnabled,
    legalEntity: s.legalEntity,
    returnWindowDays: s.returnWindowDays,
  };
}

export async function setSetting(key: keyof PlatformSettings, value: unknown): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value: value as never },
    create: { key, value: value as never },
  });
}
