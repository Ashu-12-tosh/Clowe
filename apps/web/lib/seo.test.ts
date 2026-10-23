import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProductDetail } from '@clowe/shared';
import { CONTENT_PAGES } from './contentPageList';
import {
  DESCRIPTION_FILL,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  HOME_DESCRIPTION,
  organizationJsonLd,
  productJsonLd,
  seoDescription,
  websiteJsonLd,
} from './seo';

// What Google shows under a result: 140–160 characters, real sentences, no
// menu text. And the structured data it reads for the site and its products.

const inRange = (s: string) => s.length >= DESCRIPTION_MIN && s.length <= DESCRIPTION_MAX;

describe('meta descriptions', () => {
  it('the home text is the owner’s, word for word', () => {
    expect(HOME_DESCRIPTION).toBe(
      'Shop fashion, mobiles and more from verified Indian sellers on Clowe. Try clothes on with AI before you buy. Free delivery on every order.',
    );
  });

  it('every policy and info page has its own, 140–160 characters', () => {
    for (const p of CONTENT_PAGES) {
      expect({ slug: p.slug, ok: inRange(p.description) }).toEqual({ slug: p.slug, ok: true });
    }
  });

  it('so does every other public page that states its own', () => {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    for (const rel of [
      'app/contact/page.tsx',
      'app/sell/page.tsx',
      'app/products/layout.tsx',
      'app/pages/referral-fee-schedule/page.tsx',
      'app/track/layout.tsx',
      'app/compare/layout.tsx',
      'app/ai-search/layout.tsx',
    ]) {
      const src = fs.readFileSync(path.join(web, rel), 'utf8');
      const text = src.match(/description:\s*'([^']+)'/)?.[1] ?? '';
      expect({ rel, length: text.length, ok: inRange(text) }).toMatchObject({ rel, ok: true });
    }
  });

  it('a category with a short blurb is filled up to length with true sentences', () => {
    const d = seoDescription({ lead: 'Shop Books on Clowe from verified Indian sellers', body: 'Fiction, non-fiction, academic and children’s books.', fill: DESCRIPTION_FILL });
    expect(inRange(d)).toBe(true);
    expect(d.startsWith('Shop Books on Clowe from verified Indian sellers. Fiction, non-fiction')).toBe(true);
  });

  it('a long product pitch is cut at a word and keeps who sells it', () => {
    const d = seoDescription({
      lead: 'Motorola moto g06 power (Pantone Tapestry, 4GB RAM, 64GB Storage)',
      body: 'A big 7000 mAh battery that lasts two days, a 6.88 inch 120 Hz display, a 50 MP camera and Android 15 with two OS upgrades and three years of security updates.',
      keep: ['Sold by Ashu team pvt ltd on Clowe, with free delivery'],
      fill: DESCRIPTION_FILL,
    });
    expect(d.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(d.length).toBeGreaterThanOrEqual(DESCRIPTION_MIN);
    expect(d.endsWith('Sold by Ashu team pvt ltd on Clowe, with free delivery.')).toBe(true);
    expect(d).toContain('…');
    expect(d).not.toMatch(/\s\S{1,2}…/); // no half word before the ellipsis
  });

  it('a product with no pitch still reads as sentences', () => {
    const d = seoDescription({ lead: 'Bata Men’s Jazz Slip-On Canvas Casual Shoe — Beige', keep: ['Sold by Ashu team pvt ltd on Clowe, with free delivery'], fill: DESCRIPTION_FILL });
    expect(inRange(d)).toBe(true);
    expect(d).toMatch(/^Bata Men’s Jazz Slip-On Canvas Casual Shoe — Beige\. Sold by/);
  });
});

describe('structured data', () => {
  it('names the site Clowe, also Clowe Shop, with a search box', () => {
    const w = websiteJsonLd();
    expect(w).toMatchObject({ '@type': 'WebSite', name: 'Clowe', alternateName: ['Clowe Shop', 'CLOWE SHOP'] });
    expect(w.potentialAction).toMatchObject({
      '@type': 'SearchAction',
      'query-input': 'required name=search_term_string',
    });
    expect(JSON.stringify(w.potentialAction)).toContain('/search?q={search_term_string}');
  });

  it('describes the organisation: legal name, logo, contact email and social profiles — never address, phone or GSTIN', () => {
    const o = organizationJsonLd({
      legalEntity: {
        name: 'CLOWE PARTNERS LLP',
        registeredAddress: 'H. No. 22-A, Najafgarh, New Delhi 110043',
        llpin: 'ADB-3171',
        gstin: '07AAWFC9519L1ZL',
        supportEmail: 'support@cloweshop.com',
        supportPhone: '+91 8929316316',
        supportPhoneAlt: '',
      },
      supportEmails: { customer: 'customer-support@cloweshop.com', vendor: 'vendor-support@cloweshop.com' },
      socialLinks: { facebook: 'https://www.facebook.com/x', twitter: '', instagram: 'https://www.instagram.com/cloweshop/', linkedin: '' },
    });
    expect(o).toMatchObject({
      '@type': 'Organization',
      name: 'Clowe',
      legalName: 'CLOWE PARTNERS LLP',
      email: 'customer-support@cloweshop.com',
      logo: { url: expect.stringMatching(/\/brand\/icon-512\.png$/), width: 512, height: 512 },
      contactPoint: { email: 'customer-support@cloweshop.com' },
      sameAs: ['https://www.facebook.com/x', 'https://www.instagram.com/cloweshop/'],
    });
    const text = JSON.stringify(o);
    for (const hidden of ['Najafgarh', '110043', '8929316316', '07AAWFC9519L1ZL', 'address', 'telephone', 'taxID']) {
      expect(text).not.toContain(hidden);
    }
  });

  const product = (over: Partial<ProductDetail> = {}) =>
    ({
      slug: 'bata-jazz',
      title: 'Bata Jazz',
      description: 'Canvas slip-on.',
      shortDescription: null,
      brand: 'Bata',
      category: { name: 'Casual Shoes', slug: 'casual-shoes' },
      seller: { shopName: 'Ashu team pvt ltd' },
      images: [{ url: 'https://cloweshop.com/uploads/a.webp', altText: null }],
      variants: [{ sku: 'B-1', pricePaise: 32900, stock: 10 }],
      ratingAvg: null,
      ratingCount: 0,
      testOnly: false,
      ...over,
    }) as unknown as ProductDetail;

  it('gives a product its price in rupees, stock and seller', () => {
    expect(productJsonLd(product())).toMatchObject({
      '@type': 'Product',
      name: 'Bata Jazz',
      brand: { name: 'Bata' },
      sku: 'B-1',
      offers: {
        '@type': 'Offer',
        price: '329.00',
        priceCurrency: 'INR',
        availability: 'https://schema.org/InStock',
        seller: { '@type': 'Organization', name: 'Ashu team pvt ltd' },
      },
    });
  });

  it('a price range across variants is an AggregateOffer; sold out says so', () => {
    const range = productJsonLd(product({ variants: [{ pricePaise: 100000, stock: 1 }, { pricePaise: 150000, stock: 2 }] as ProductDetail['variants'] }));
    expect(range?.offers).toMatchObject({ '@type': 'AggregateOffer', lowPrice: '1000.00', highPrice: '1500.00', offerCount: 2 });
    const soldOut = productJsonLd(product({ variants: [{ pricePaise: 32900, stock: 0 }] as ProductDetail['variants'] }));
    expect(soldOut?.offers).toMatchObject({ availability: 'https://schema.org/OutOfStock' });
  });

  it('nothing for a test listing', () => {
    expect(productJsonLd(product({ testOnly: true }))).toBeNull();
  });
});
