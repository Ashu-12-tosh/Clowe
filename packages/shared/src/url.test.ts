import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppPath, isHttpUrl, safeHref } from './url';
import { imageUrlSchema } from './imageUrl';
import { returnRequestSchema } from './checkout';
import { storeProfileSchema } from './sellerStore';
import { updateSettingsSchema } from './settings';
import { bannerUpsertSchema, promoTileUpsertSchema } from './home';
import { tryOnRequestSchema, saveTryOnPhotoSchema } from './tryon';
import { updateProfileSchema } from './auth';

/** Values that must never be stored or rendered as a link. */
const REFUSED = [
  'javascript:alert(1)',
  ' JavaScript:alert(1)',
  'jav\tascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml,<svg/onload=alert(1)>',
  'vbscript:msgbox(1)',
  '//evil.example/x',
  '/\\evil.example/x',
  '/\t/evil.example',
  'https:evil.example',
  'https:///evil.example',
  'mailto:a@b.c',
  'ftp://files.example/x',
  '',
];

describe('isHttpUrl / isAppPath / safeHref', () => {
  it('refuses every other scheme and every way to reach another host from a path', () => {
    for (const v of REFUSED) expect(safeHref(v), JSON.stringify(v)).toBeNull();
  });

  it('accepts http(s) URLs and paths on this site', () => {
    for (const v of ['https://instagram.com/clowe', 'http://localhost:4400/uploads/a.png', 'https://res.cloudinary.com/x/y.jpg']) {
      expect(isHttpUrl(v), v).toBe(true);
    }
    for (const v of ['/', '/products', '/products?category=fashion', '/uploads/demo/a.jpg']) {
      expect(isAppPath(v), v).toBe(true);
    }
    expect(safeHref('  /products  ')).toBe('/products');
    expect(safeHref(null)).toBeNull();
  });
});

describe('every schema that stores a link refuses the unsafe schemes', () => {
  const bad = 'javascript:alert(1)';

  it('return photos (buyer)', () => {
    expect(returnRequestSchema.safeParse({ reason: 'DAMAGED', photos: [bad] }).success).toBe(false);
    expect(returnRequestSchema.safeParse({ reason: 'DAMAGED', photos: ['https://cloweshop.com/uploads/a.jpg'] }).success).toBe(true);
  });

  it('store social links, logo and banner (seller)', () => {
    const socials = { website: bad, instagram: '', facebook: '', youtube: '' };
    expect(storeProfileSchema.safeParse({ shopName: 'Shop', socialLinks: socials }).success).toBe(false);
    expect(storeProfileSchema.safeParse({ shopName: 'Shop', logoUrl: bad }).success).toBe(false);
    expect(storeProfileSchema.safeParse({ shopName: 'Shop', bannerUrl: 'data:image/png;base64,AAAA' }).success).toBe(false);
    expect(
      storeProfileSchema.safeParse({ shopName: 'Shop', socialLinks: { ...socials, website: 'https://shop.example' } }).success,
    ).toBe(true);
  });

  it('platform footer social links (admin)', () => {
    const links = { facebook: bad, twitter: '', instagram: '', linkedin: '' };
    expect(updateSettingsSchema.safeParse({ socialLinks: links }).success).toBe(false);
  });

  it('home banner and promo tile links (admin), which render as same-tab links', () => {
    expect(bannerUpsertSchema.safeParse({ headline: 'Sale on', primaryHref: bad }).success).toBe(false);
    expect(bannerUpsertSchema.safeParse({ headline: 'Sale on', secondaryHref: '//evil.example' }).success).toBe(false);
    expect(bannerUpsertSchema.safeParse({ headline: 'Sale on', primaryHref: '/products', secondaryHref: '' }).success).toBe(true);
    expect(promoTileUpsertSchema.safeParse({ placement: 'PROMO_CARD', title: 'Deals', href: bad }).success).toBe(false);
    expect(promoTileUpsertSchema.safeParse({ placement: 'PROMO_CARD', title: 'Deals', href: '/products?category=fashion' }).success).toBe(true);
  });

  it('images, avatar and try-on photo', () => {
    expect(imageUrlSchema.safeParse(bad).success).toBe(false);
    expect(imageUrlSchema.safeParse('data:image/svg+xml,x').success).toBe(false);
    expect(imageUrlSchema.safeParse('/uploads/../etc/passwd').success).toBe(false);
    expect(updateProfileSchema.safeParse({ avatarUrl: bad }).success).toBe(false);
    expect(tryOnRequestSchema.safeParse({ productId: 'p', photoUrl: bad }).success).toBe(false);
    expect(saveTryOnPhotoSchema.safeParse({ photoUrl: bad }).success).toBe(false);
  });
});

describe('guard: no bare .url() in the shared schemas', () => {
  it('is not called anywhere in src (it accepts javascript: and data:)', () => {
    const dir = path.resolve(__dirname);
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      readFileSync(path.join(dir, file), 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '');
          if (/\.url\(\s*\)/.test(code)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
