import type { LegalEntity, ProductDetail, PublicSettings } from '@clowe/shared';

// ---------------------------------------------------------------------------
// What search engines read: meta descriptions and structured data (JSON-LD).
// ---------------------------------------------------------------------------

/** The site's own address; structured data always names the production URL form. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cloweshop.com').replace(/\/$/, '');

/** The home page's search snippet (owner, 23 Oct 2026), and the site's default. */
export const HOME_DESCRIPTION =
  'Shop fashion, mobiles and more from verified Indian sellers on Clowe. Try clothes on with AI before you buy. Free delivery on every order.';

/** Google shows about 155–160 characters; shorter than ~140 wastes the snippet. */
export const DESCRIPTION_MIN = 140;
export const DESCRIPTION_MAX = 160;

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
/** A sentence: whitespace folded, a full stop added when it has none. */
const sentence = (s: string | null | undefined) => {
  const c = clean(s);
  return !c ? '' : /[.!?…]$/.test(c) ? c : `${c}.`;
};
/** At most `max` characters, cut at a word, with an ellipsis when cut. */
function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1).replace(/\s+\S*$/, '').replace(/[\s,;:—–-]+$/, '');
  return `${cut}…`;
}

/**
 * A meta description of 140–160 characters: the lead, as much of the body as
 * fits, then `keep` (always shown, e.g. who sells it), then `fill` sentences
 * while it is still short. Words are never cut in half.
 */
export function seoDescription({
  lead,
  body,
  keep = [],
  fill = [],
}: {
  lead: string;
  body?: string | null;
  keep?: string[];
  fill?: string[];
}): string {
  const tail = keep.map(sentence).filter(Boolean).join(' ');
  const reserve = tail ? tail.length + 1 : 0;
  let out = cutAtWord(sentence(lead), DESCRIPTION_MAX - reserve);
  const room = DESCRIPTION_MAX - reserve - out.length - 1;
  const b = sentence(body);
  if (b && room >= 20) out = `${out} ${b.length <= room ? b : cutAtWord(b, room)}`;
  if (tail) out = `${out} ${tail}`;
  for (const f of fill.map(sentence).filter(Boolean)) {
    if (out.length >= DESCRIPTION_MIN) break;
    if (out.length + 1 + f.length <= DESCRIPTION_MAX) out = `${out} ${f}`;
  }
  return out;
}

/** Sentences that are true of every order, to bring a short description up to length. */
export const DESCRIPTION_FILL = ['Prices include GST.', 'Free delivery on every order.', 'Secure online payments.', 'Every seller approved by Clowe.'];

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** The square Clowe mark, 512 px: what Google may show beside the site's name. */
export const LOGO_URL = `${SITE_URL}/brand/icon-512.png`;

export function websiteJsonLd(): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    name: 'Clowe',
    alternateName: ['Clowe Shop', 'CLOWE SHOP'],
    url: `${SITE_URL}/`,
    inLanguage: 'en-IN',
    publisher: { '@id': `${SITE_URL}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/search?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
}

export function organizationJsonLd(settings: Partial<PublicSettings> | null): Json {
  const legal: Partial<LegalEntity> = settings?.legalEntity ?? {};
  const email = settings?.supportEmails?.customer || legal.supportEmail || undefined;
  const social = settings?.socialLinks ? Object.values(settings.socialLinks).filter((u) => /^https:\/\//.test(u)) : [];
  // Owner, 24 Oct 2026: the legal name and email addresses only — no
  // registered address, phone number, GSTIN or LLPIN on the website.
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: 'Clowe',
    alternateName: 'Clowe Shop',
    legalName: legal.name || 'CLOWE PARTNERS LLP',
    url: `${SITE_URL}/`,
    logo: { '@type': 'ImageObject', url: LOGO_URL, width: 512, height: 512 },
    ...(email
      ? {
          email,
          contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', email, areaServed: 'IN', availableLanguage: ['English', 'Hindi'] },
        }
      : {}),
    ...(social.length ? { sameAs: social } : {}),
  };
}

const rupees = (paise: number) => (paise / 100).toFixed(2);

/** Product + Offer for a product page; null for one search engines must not index. */
export function productJsonLd(product: ProductDetail): Json | null {
  if (product.testOnly) return null;
  const variants = product.variants;
  if (variants.length === 0) return null;
  const inStock = variants.filter((v) => v.stock > 0);
  const priced = inStock.length ? inStock : variants;
  const prices = priced.map((v) => v.pricePaise);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const url = `${SITE_URL}/products/${product.slug}`;
  const availability = inStock.length ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
  const seller = { '@type': 'Organization', name: product.seller.shopName };
  // Free delivery to every Indian PIN code (Shipping Policy).
  const shipping = {
    '@type': 'OfferShippingDetails',
    shippingRate: { '@type': 'MonetaryAmount', value: '0', currency: 'INR' },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'IN' },
  };
  const offers =
    low === high
      ? {
          '@type': 'Offer',
          url,
          price: rupees(low),
          priceCurrency: 'INR',
          availability,
          itemCondition: 'https://schema.org/NewCondition',
          seller,
          shippingDetails: shipping,
        }
      : {
          '@type': 'AggregateOffer',
          url,
          lowPrice: rupees(low),
          highPrice: rupees(high),
          offerCount: priced.length,
          priceCurrency: 'INR',
          availability,
          seller,
        };
  const images = product.images.map((i) => (i.url.startsWith('http') ? i.url : `${SITE_URL}${i.url}`)).slice(0, 10);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    url,
    ...(images.length ? { image: images } : {}),
    description: clean(product.shortDescription || product.description).slice(0, 5000),
    ...(product.brand ? { brand: { '@type': 'Brand', name: product.brand } } : {}),
    ...(variants.length === 1 && variants[0]!.sku ? { sku: variants[0]!.sku } : {}),
    category: product.category.name,
    offers,
    ...(product.ratingAvg != null && product.ratingCount > 0
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: product.ratingAvg.toFixed(1), reviewCount: product.ratingCount } }
      : {}),
  };
}
