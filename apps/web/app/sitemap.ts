import type { MetadataRoute } from 'next';
import type { CategoryNode, ProductListItem } from '@clowe/shared';
import { CONTENT_PAGES } from '@/lib/contentPageList';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export const revalidate = 3600; // regenerate hourly

/** Live products are listed up to this many pages of 48. */
const PRODUCT_PAGES = 20;

async function apiData<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: T }).data ?? null;
  } catch {
    return null; // the sitemap still works if the API is down
  }
}

/**
 * Every page worth finding: home, the listing, Contact Us and the policy and
 * help pages, each category the storefront shows (closed ones are not in the
 * tree), and the live products.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/products`, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${SITE_URL}/contact`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE_URL}/sell`, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${SITE_URL}/track`, changeFrequency: 'monthly', priority: 0.3 },
    ...CONTENT_PAGES.map((p) => ({
      url: `${SITE_URL}/pages/${p.slug}`,
      changeFrequency: 'monthly' as const,
      priority: 0.4,
    })),
  ];

  const tree = (await apiData<CategoryNode[]>('/api/categories')) ?? [];
  const walk = (nodes: CategoryNode[]): CategoryNode[] => nodes.flatMap((n) => [n, ...walk(n.children)]);
  for (const category of walk(tree)) {
    pages.push({ url: `${SITE_URL}/category/${category.slug}`, changeFrequency: 'daily', priority: 0.7 });
  }

  for (let page = 1; page <= PRODUCT_PAGES; page++) {
    const list = await apiData<{ items: ProductListItem[]; totalPages?: number; total?: number }>(
      `/api/products?limit=48&page=${page}`,
    );
    if (!list || list.items.length === 0) break;
    for (const p of list.items) {
      pages.push({ url: `${SITE_URL}/products/${p.slug}`, changeFrequency: 'daily', priority: 0.6 });
    }
    if (list.items.length < 48) break;
  }
  return pages;
}
