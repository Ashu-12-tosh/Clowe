import type { PlatformSettings, PublicSettings } from '@clowe/shared';
import { prisma } from '../db';

/** Defaults — a key missing from the DB falls back to these. */
export const DEFAULT_SETTINGS: PlatformSettings = {
  tryonMinPricePaise: 200000, // ₹2,000
  socialLinks: { facebook: '', twitter: '', instagram: '' },
  adPricing: {
    HOME_BANNER: { '7': 49900, '15': 89900, '30': 149900 },
    CATEGORY_SPONSORED: { '7': 29900, '15': 49900, '30': 79900 },
  },
};

/** Full settings: DB rows merged over defaults. */
export async function getSettings(): Promise<PlatformSettings> {
  const rows = await prisma.platformSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    tryonMinPricePaise:
      (byKey.get('tryonMinPricePaise') as number | undefined) ?? DEFAULT_SETTINGS.tryonMinPricePaise,
    socialLinks:
      (byKey.get('socialLinks') as PlatformSettings['socialLinks'] | undefined) ??
      DEFAULT_SETTINGS.socialLinks,
    adPricing:
      (byKey.get('adPricing') as PlatformSettings['adPricing'] | undefined) ??
      DEFAULT_SETTINGS.adPricing,
  };
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const s = await getSettings();
  return { tryonMinPricePaise: s.tryonMinPricePaise, socialLinks: s.socialLinks };
}

export async function setSetting(key: keyof PlatformSettings, value: unknown): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value: value as never },
    create: { key, value: value as never },
  });
}
