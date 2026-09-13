import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export const revalidate = 3600; // regenerate hourly

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/products`, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${SITE_URL}/track`, changeFrequency: 'monthly', priority: 0.3 },
  ];

  // Live product pages — best-effort (sitemap still works if the API is down).
  try {
    const res = await fetch(`${API_URL}/api/products?limit=48`, { next: { revalidate: 3600 } });
    const json = await res.json();
    const products: MetadataRoute.Sitemap = (json.data?.items ?? []).map(
      (p: { slug: string }) => ({
        url: `${SITE_URL}/products/${p.slug}`,
        changeFrequency: 'daily' as const,
        priority: 0.7,
      }),
    );
    return [...staticPages, ...products];
  } catch {
    return staticPages;
  }
}
