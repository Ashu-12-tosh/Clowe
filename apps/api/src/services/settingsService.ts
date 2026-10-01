import {
  DEFAULT_KYC_NAME_MATCH_MIN_SCORE,
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
  payoutTdsPercent: 1, // section 194-O
  payoutMinPaise: 100000, // ₹1,000
  payoutHoldDays: env.RETURN_WINDOW_DAYS,
  dispatchWindowHours: 12,
  lateDispatchPenaltyPaise: 8000, // ₹80
  penaltyEnabled: true,
  gstRatePercent: 18,
  platformFeePaise: 900, // ₹9 per line
  deliveryFeePaise: 6000, // ₹60 per shipment
  closingFeePaise: 2000, // ₹20 per unit — placeholder
  returnWindowDays: env.RETURN_WINDOW_DAYS,
  auditRetentionDays: 365,
  kycNameMatchMinScore: DEFAULT_KYC_NAME_MATCH_MIN_SCORE,
  // Off. Coupons are built and seeded but not offered; flipping this to true
  // — here or from admin settings — brings the whole feature back with no
  // other change.
  couponsEnabled: false,
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
    payoutMinPaise:
      (byKey.get('payoutMinPaise') as number | undefined) ?? DEFAULT_SETTINGS.payoutMinPaise,
    payoutHoldDays:
      (byKey.get('payoutHoldDays') as number | undefined) ?? DEFAULT_SETTINGS.payoutHoldDays,
    dispatchWindowHours:
      (byKey.get('dispatchWindowHours') as number | undefined) ?? DEFAULT_SETTINGS.dispatchWindowHours,
    lateDispatchPenaltyPaise:
      (byKey.get('lateDispatchPenaltyPaise') as number | undefined) ??
      DEFAULT_SETTINGS.lateDispatchPenaltyPaise,
    penaltyEnabled:
      (byKey.get('penaltyEnabled') as boolean | undefined) ?? DEFAULT_SETTINGS.penaltyEnabled,
    gstRatePercent:
      (byKey.get('gstRatePercent') as number | undefined) ?? DEFAULT_SETTINGS.gstRatePercent,
    platformFeePaise:
      (byKey.get('platformFeePaise') as number | undefined) ?? DEFAULT_SETTINGS.platformFeePaise,
    deliveryFeePaise:
      (byKey.get('deliveryFeePaise') as number | undefined) ?? DEFAULT_SETTINGS.deliveryFeePaise,
    closingFeePaise:
      (byKey.get('closingFeePaise') as number | undefined) ?? DEFAULT_SETTINGS.closingFeePaise,
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
    dispatchWindowHours: s.dispatchWindowHours,
    penaltyEnabled: s.penaltyEnabled,
    socialLinks: s.socialLinks,
    supportEmails: s.supportEmails,
    codMaxOrderPaise: s.codMaxOrderPaise,
    pdpOffers: s.pdpOffers,
    couponsEnabled: s.couponsEnabled,
  };
}

export async function setSetting(key: keyof PlatformSettings, value: unknown): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value: value as never },
    create: { key, value: value as never },
  });
}
