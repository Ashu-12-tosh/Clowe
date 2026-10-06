import type { Prisma } from '@prisma/client';
import { categoryRows } from './categoryRules';
import { getSettings } from './settingsService';

/**
 * Food categories, closed until there is an FSSAI licence
 * (PlatformSettings.foodCategoriesEnabled, off by default).
 *
 * Closed means hidden, not deleted: the categories, their products and every
 * order stay in the database untouched, and the setting going on brings all of
 * it back with no other change. While closed, shoppers cannot find, open or
 * buy anything filed under these roots (at any depth), and sellers cannot list
 * anything new there. Admin screens still see everything.
 */
export const FOOD_CATEGORY_ROOT_SLUGS = ['grocery', 'supplements'] as const;

/** Every category under the food roots, roots included — empty while they are open. */
export async function hiddenCategories(): Promise<{ ids: Set<string>; slugs: Set<string> }> {
  if ((await getSettings()).foodCategoriesEnabled) return { ids: new Set(), slugs: new Set() };
  const rows = [...(await categoryRows()).values()];
  const roots: readonly string[] = FOOD_CATEGORY_ROOT_SLUGS;
  const hidden = new Set(rows.filter((r) => roots.includes(r.slug)).map((r) => r.id));
  // Walk down until nothing new is added: any depth, any order.
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (r.parentId && hidden.has(r.parentId) && !hidden.has(r.id)) {
        hidden.add(r.id);
        grew = true;
      }
    }
  }
  return { ids: hidden, slugs: new Set(rows.filter((r) => hidden.has(r.id)).map((r) => r.slug)) };
}

export async function hiddenCategoryIds(): Promise<Set<string>> {
  return (await hiddenCategories()).ids;
}

/**
 * True when a storefront link opens a hidden category — /category/<slug> or
 * ?category=<slug> — so a banner or promo tile pointing there can be left out
 * rather than lead to a 404.
 */
export function linksToHiddenCategory(href: string | null | undefined, hiddenSlugs: Set<string>): boolean {
  if (!href || hiddenSlugs.size === 0) return false;
  let url: URL;
  try {
    url = new URL(href, 'https://storefront.invalid');
  } catch {
    return false;
  }
  const page = /^\/category\/([^/]+)/.exec(url.pathname);
  if (page && hiddenSlugs.has(decodeURIComponent(page[1]))) return true;
  const param = url.searchParams.get('category');
  return param !== null && hiddenSlugs.has(param);
}

/**
 * Spread into a storefront product query. It sits under NOT so it never
 * collides with a categoryId filter the query sets for itself — a later
 * spread of one would silently drop it.
 */
export async function visibleCategoryWhere(): Promise<Prisma.ProductWhereInput> {
  const hidden = await hiddenCategoryIds();
  return hidden.size ? { NOT: { categoryId: { in: [...hidden] } } } : {};
}

/** For one product already loaded: true when shoppers must not see it. */
export async function isHiddenCategory(categoryId: string): Promise<boolean> {
  return (await hiddenCategoryIds()).has(categoryId);
}
