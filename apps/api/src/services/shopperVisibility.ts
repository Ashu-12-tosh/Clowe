import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { categoryRows } from './categoryRules';
import { getSettings } from './settingsService';

/**
 * What shoppers must not see, and the one place that decides it. Two platform
 * settings close parts of the catalog; both hide, never delete:
 *
 * - foodCategoriesEnabled (off until there is an FSSAI licence): Grocery and
 *   Supplements, everything under them at any depth, and their products.
 *   Sellers cannot list anything new there either.
 * - demoCatalogEnabled (off by default): the seeded demo store
 *   (SellerProfile.isDemo) and every product it carries — stock photos, not
 *   real goods. Its store page is a 404 too.
 *
 * The rows stay in the database untouched — categories, products, cart lines,
 * wishlist entries, orders — and the setting going on brings all of it back
 * with no other change. Admin screens still see everything.
 */
export const FOOD_CATEGORY_ROOT_SLUGS = ['grocery', 'supplements'] as const;

export interface ShopperHidden {
  /** Food categories (roots and everything under them) while closed. */
  categoryIds: Set<string>;
  categorySlugs: Set<string>;
  /** Demo sellers while the demo catalog is off. */
  sellerIds: Set<string>;
}

/** One read of both settings; empty sets for whatever is open. */
export async function shopperHidden(): Promise<ShopperHidden> {
  const settings = await getSettings();
  const out: ShopperHidden = { categoryIds: new Set(), categorySlugs: new Set(), sellerIds: new Set() };

  if (!settings.foodCategoriesEnabled) {
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
    out.categoryIds = hidden;
    out.categorySlugs = new Set(rows.filter((r) => hidden.has(r.id)).map((r) => r.slug));
  }

  if (!settings.demoCatalogEnabled) {
    const demo = await prisma.sellerProfile.findMany({ where: { isDemo: true }, select: { id: true } });
    out.sellerIds = new Set(demo.map((s) => s.id));
  }
  return out;
}

/** Hidden food categories — for category lists, pages and the seller's picker. */
export async function hiddenCategoryIds(): Promise<Set<string>> {
  return (await shopperHidden()).categoryIds;
}

export async function isHiddenCategory(categoryId: string): Promise<boolean> {
  return (await hiddenCategoryIds()).has(categoryId);
}

/** A store shoppers must not reach (the demo store while the demo catalog is off). */
export async function isHiddenSeller(sellerId: string): Promise<boolean> {
  return (await shopperHidden()).sellerIds.has(sellerId);
}

/**
 * Spread into a storefront product query. It sits under NOT so it never
 * collides with a categoryId or sellerId filter the query sets for itself —
 * a later spread of one would silently drop it.
 */
export async function visibleProductWhere(): Promise<Prisma.ProductWhereInput> {
  return whereFrom(await shopperHidden());
}

export function whereFrom(hidden: ShopperHidden): Prisma.ProductWhereInput {
  const or: Prisma.ProductWhereInput[] = [];
  if (hidden.categoryIds.size) or.push({ categoryId: { in: [...hidden.categoryIds] } });
  if (hidden.sellerIds.size) or.push({ sellerId: { in: [...hidden.sellerIds] } });
  return or.length ? { NOT: { OR: or } } : {};
}

type ProductKey = { categoryId: string; sellerId: string };

export function productTestFrom(hidden: ShopperHidden): (p: ProductKey) => boolean {
  return (p) => hidden.categoryIds.has(p.categoryId) || hidden.sellerIds.has(p.sellerId);
}

/** For filtering rows already loaded: true when shoppers must not see the product. */
export async function hiddenProductTest(): Promise<(p: ProductKey) => boolean> {
  return productTestFrom(await shopperHidden());
}

/** For one product already loaded. */
export async function isHiddenProduct(p: ProductKey): Promise<boolean> {
  return (await hiddenProductTest())(p);
}

/** The category a storefront link opens — /category/<slug> or ?category=<slug> — or null. */
export function linkedCategorySlug(href: string | null | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, 'https://storefront.invalid');
  } catch {
    return null;
  }
  const page = /^\/category\/([^/]+)/.exec(url.pathname);
  if (page) return decodeURIComponent(page[1]);
  return url.searchParams.get('category');
}

/** True when a banner or promo link opens a closed category: left out rather than lead to a 404. */
export function linksToHiddenCategory(href: string | null | undefined, hiddenSlugs: Set<string>): boolean {
  const slug = linkedCategorySlug(href);
  return slug !== null && hiddenSlugs.has(slug);
}
