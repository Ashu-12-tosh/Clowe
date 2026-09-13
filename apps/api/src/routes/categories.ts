import { Router } from 'express';
import type { CategoryCallout, CategoryDetail, CategoryNode } from '@clowe/shared';
import { prisma } from '../db';
import { chainOf, descendantIds, rulesFromChain } from '../services/categoryRules';
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

// Full active category tree (roots with children), for nav + filters.
categoriesRouter.get('/', async (_req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const byId = new Map(categories.map((c) => [c.id, c]));
    const byParent = new Map<string | null, typeof categories>();
    for (const cat of categories) {
      const list = byParent.get(cat.parentId) ?? [];
      list.push(cat);
      byParent.set(cat.parentId, list);
    }

    const toNode = (cat: (typeof categories)[number]): CategoryNode => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      imageUrl: cat.imageUrl,
      icon: cat.icon,
      // Rules resolve up the chain in memory - the tree is already loaded.
      rules: rulesFromChain(chainOf(byId, cat.id)),
      children: (byParent.get(cat.id) ?? []).map(toNode),
    });

    const tree = (byParent.get(null) ?? []).map(toNode);
    res.json({ success: true, data: tree });
  } catch (err) {
    next(err);
  }
});

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
    if (!category || !category.isActive) throw ApiError.notFound('Category not found');

    // One grouped count covers the category and every child in one round trip.
    const scopeIds = await descendantIds(category.id);
    const counts = await prisma.product.groupBy({
      by: ['categoryId'],
      where: { status: 'APPROVED', isVisible: true, seller: { vacationMode: false }, categoryId: { in: scopeIds } },
      _count: { _all: true },
    });
    const countById = new Map(counts.map((c) => [c.categoryId, c._count._all]));

    const body: CategoryDetail = {
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      tileShape: category.tileShape === 'circle' ? 'circle' : 'square',
      banners: category.banners.map((b) => ({
        id: b.id,
        eyebrow: b.eyebrow,
        headline: b.headline,
        highlight: b.highlight,
        subtext: b.subtext,
        imageUrl: b.imageUrl,
        primaryLabel: b.primaryLabel,
        primaryHref: b.primaryHref,
      })),
      highlights: asCallouts(category.highlights),
      features: asCallouts(category.features),
      children: category.children.map((child) => ({
        id: child.id,
        name: child.name,
        slug: child.slug,
        imageUrl: child.imageUrl,
        productCount: countById.get(child.id) ?? 0,
      })),
      productCount: scopeIds.reduce((sum, id) => sum + (countById.get(id) ?? 0), 0),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
