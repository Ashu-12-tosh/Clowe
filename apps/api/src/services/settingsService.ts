import type { PlatformSettings, PublicSettings } from '@clowe/shared';
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
  returnWindowDays: env.RETURN_WINDOW_DAYS,
  auditRetentionDays: 365,
  socialLinks: { facebook: '', twitter: '', instagram: '' },
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
    returnWindowDays:
      (byKey.get('returnWindowDays') as number | undefined) ?? DEFAULT_SETTINGS.returnWindowDays,
    auditRetentionDays:
      (byKey.get('auditRetentionDays') as number | undefined) ??
      DEFAULT_SETTINGS.auditRetentionDays,
    socialLinks:
      (byKey.get('socialLinks') as PlatformSettings['socialLinks'] | undefined) ??
      DEFAULT_SETTINGS.socialLinks,
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
    socialLinks: s.socialLinks,
    pdpOffers: s.pdpOffers,
  };
}

export async function setSetting(key: keyof PlatformSettings, value: unknown): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value: value as never },
    create: { key, value: value as never },
  });
}
