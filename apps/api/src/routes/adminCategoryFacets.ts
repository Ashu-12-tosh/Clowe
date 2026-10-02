import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  categoryFacetsUpdateSchema,
  facetConfigFromJson,
  normaliseAttributes,
  optionValuesFromJson,
  type AdminCategoryFacets,
  type AdminFacetRow,
  type ResolvedFacet,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import {
  categoryRows,
  chainOf,
  descendantIds,
  facetsFromChain,
  invalidateCategoryRules,
} from '../services/categoryRules';
import { hasFacetValue, readFacet } from '../services/facetData';
import { LIVE_PRODUCT_WHERE } from '../services/productSearch';

/**
 * One category's filter facets: what it stores, what it inherits, what
 * shoppers see, and what each child ends up with — so an edit's reach is
 * visible before it is saved.
 */
export const adminCategoryFacetsRouter = Router();
adminCategoryFacetsRouter.use(requireAuth, requireRole('ADMIN'));

async function view(categoryId: string): Promise<AdminCategoryFacets> {
  const rows = await categoryRows();
  const category = rows.get(categoryId);
  if (!category) throw ApiError.notFound('Category not found');
  const chain = chainOf(rows, categoryId);
  const nameOf = (id: string) => rows.get(id)?.name ?? '';

  const products = await prisma.product.findMany({
    where: { ...LIVE_PRODUCT_WHERE, categoryId: { in: await descendantIds(categoryId) } },
    select: { attributes: true, variants: { select: { optionValues: true } } },
  });
  const readings = products.map((p) => ({
    attributes: normaliseAttributes(p.attributes),
    options: p.variants.map((v) => optionValuesFromJson(v.optionValues)),
  }));
  const row = (facet: ResolvedFacet): AdminFacetRow => ({
    ...facet,
    fromCategoryName: nameOf(facet.fromCategoryId),
    productsWithValue: readings.filter((r) => hasFacetValue(readFacet(r.attributes, r.options, facet))).length,
  });

  const children = [...rows.values()]
    .filter((r) => r.parentId === categoryId)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    category: {
      id: category.id,
      name: category.name,
      slug: category.slug,
      path: [...chain].reverse().map((c) => ({ id: c.id, name: c.name })),
    },
    own: facetConfigFromJson(category.facets),
    inherited: facetsFromChain(chain.slice(1)).map(row),
    resolved: facetsFromChain(chain).map(row),
    liveProducts: products.length,
    children: children.map((child) => ({
      id: child.id,
      name: child.name,
      slug: child.slug,
      hasOwn: facetConfigFromJson(child.facets) !== null,
      facets: facetsFromChain(chainOf(rows, child.id)).map((f) => ({ key: f.key, label: f.label })),
    })),
  };
}

adminCategoryFacetsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await view(req.params.id) });
  } catch (err) {
    next(err);
  }
});

adminCategoryFacetsRouter.put('/:id', async (req, res, next) => {
  try {
    const { config } = categoryFacetsUpdateSchema.parse(req.body);
    const exists = await prisma.category.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) throw ApiError.notFound('Category not found');
    await prisma.category.update({
      where: { id: exists.id },
      data: { facets: config === null ? Prisma.DbNull : (config as Prisma.InputJsonValue) },
    });
    invalidateCategoryRules();
    res.json({ success: true, data: await view(exists.id) });
  } catch (err) {
    next(err);
  }
});
