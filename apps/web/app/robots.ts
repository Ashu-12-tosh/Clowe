import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Private/account areas — nothing useful for crawlers.
      disallow: ['/admin', '/seller', '/cart', '/checkout', '/orders', '/notifications', '/referrals', '/tryon', '/login', '/wishlist'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
