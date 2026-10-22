import { Router } from 'express';
import type { CategoryCallout, CategoryDetail, CategoryNode } from '@clowe/shared';
import { prisma } from '../db';
import { categoryIcon, specFieldsFor } from '@clowe/shared';
import { categoryRows, chainOf, descendantIds, facetsFromChain, rulesFromChain } from '../services/categoryRules';
import { isStockPhoto } from '../services/stockPhotos';
import { hiddenCategoryIds, visibleProductWhere } from '../services/shopperVisibility';
import { getSettings } from '../services/settingsService';
import { ApiError } from '../utils/ApiError';

export const categoriesRouter = Router();

/**
 * Highlights/features are free-form JSON columns; keep only rows that actually
 * carry the three strings the UI renders.
 */
function asCallouts(value: unknown): CategoryCallout[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const { icon, title, subtitle } = row as Record<string, unknown>;
    if (typeof icon !== 'string' || typeof title !== 'string') return [];
    return [{ icon, title, subtitle: typeof subtitle === 'string' ? subtitle : '' }];
  });
}

// Full active category tree (roots with children), for nav + filters, and
// for the seller's category picker — so a closed food category is in neither.
categoriesRouter.get('/', async (_req, res, next) => {
  try {
    const hidden = await hiddenCategoryIds();
    const categories = (
      await prisma.category.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      })
    ).filter((c) => !hidden.has(c.id));

    const byId = new Map(categories.map((c) => [c.id, c]));
    const byParent = new Map<string | null, typeof categories>();
    for (const cat of categories) {
      const list = byParent.get(cat.parentId) ?? [];
      list.push(cat);
      byParent.set(cat.parentId, list);
    }

    const toNode = (cat: (typeof categories)[number]): CategoryNode => {
      // Rules and facets resolve up the chain in memory - the tree is already loaded.
      const chain = chainOf(byId, cat.id);
      const rules = rulesFromChain(chain);
      return {
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        imageUrl: cat.imageUrl,
        icon: categoryIcon(cat, cat.parentId ? byId.get(cat.parentId)?.icon : null),
        rules,
        specFields: specFieldsFor(rules, facetsFromChain(chain)),
        children: (byParent.get(cat.id) ?? []).map(toNode),
      };
    };

    const tree = (byParent.get(null) ?? []).map(toNode);
    res.json({ success: true, data: tree });
  } catch (err) {
    next(err);
  }
});

/**
 * The top-level departments with something live to buy, in menu order — for
 * an empty department's page to point shoppers somewhere that has products.
 */
async function liveDepartments(hidden: Set<string>): Promise<{ name: string; slug: string }[]> {
  const [groups, rows, roots] = await Promise.all([
    // What a shopper can actually buy: not a hidden seller's listing, nor a test listing.
    prisma.product.groupBy({ by: ['categoryId'], where: { status: 'APPROVED', isVisible: true, seller: { vacationMode: false }, ...(await visibleProductWhere()) } }),
    categoryRows(),
    prisma.category.findMany({ where: { isActive: true, parentId: null }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, slug: true } }),
  ]);
  const live = new Set<string>();
  for (const { categoryId } of groups) {
    let row = rows.get(categoryId);
    while (row?.parentId) row = rows.get(row.parentId);
    if (row) live.add(row.id);
  }
  return roots.filter((r) => live.has(r.id) && !hidden.has(r.id)).map(({ name, slug }) => ({ name, slug }));
}

// One category's landing page: banner, blurb and subcategory tiles with counts.
categoriesRouter.get('/:slug', async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({
      where: { slug: req.params.slug },
      include: {
        children: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
        banners: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    const hidden = await hiddenCategoryIds();
    if (!category || !category.isActive || hidden.has(category.id)) {
      throw ApiError.notFound('Category not found');
    }

    // One grouped count covers the category and every child in one round trip.
    const scopeIds = await descendantIds(category.id);
    const counts = await prisma.product.groupBy({
      by: ['categoryId'],
      // Counted as shoppers see them: a hidden seller's or a test listing makes no department "live".
      where: { status: 'APPROVED', isVisible: true, seller: { vacationMode: false }, categoryId: { in: scopeIds }, ...(await visibleProductWhere()) },
      _count: { _all: true },
    });
    const countById = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    const showStock = (await getSettings()).demoCatalogEnabled;

    const body: CategoryDetail = {
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      icon: category.icon,
      tileShape: category.tileShape === 'circle' ? 'circle' : 'square',
      // Clowe's own banner art only: a stock/random photo is never shown, even if switched on
      // (unless the admin turned the demo catalog on, which is stock photos by design).
      banners: category.banners.filter((b) => showStock || !b.imageUrl || !isStockPhoto(b.imageUrl)).map((b) => ({
        id: b.id,
        eyebrow: b.eyebrow,
        headline: b.headline,
        highlight: b.highlight,
        subtext: b.subtext,
        imageUrl: b.imageUrl,
        primaryLabel: b.primaryLabel,
        primaryHref: b.primaryHref,
        imageMode: b.imageMode,
        altText: b.altText,
        mobileImageUrl: b.mobileImageUrl,
        focalX: b.focalX,
        focalY: b.focalY,
      })),
      highlights: asCallouts(category.highlights),
      features: asCallouts(category.features),
      children: category.children.map((child) => ({
        id: child.id,
        name: child.name,
        slug: child.slug,
        imageUrl: child.imageUrl,
        // Its own icon, else its own from the subcategory list, else the parent's.
        icon: categoryIcon(child, category.icon),
        productCount: countById.get(child.id) ?? 0,
      })),
      productCount: scopeIds.reduce((sum, id) => sum + (countById.get(id) ?? 0), 0),
      liveDepartments: [],
    };
    if (body.productCount === 0) body.liveDepartments = (await liveDepartments(hidden)).filter((d) => d.slug !== category.slug);
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
