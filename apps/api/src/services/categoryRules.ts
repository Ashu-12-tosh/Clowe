import type { Prisma } from '@prisma/client';
import {
  categoryRuleFieldsFromRow,
  facetConfigFromJson,
  resolveCategoryRules,
  resolveFacets,
  type CategoryRuleFields,
  type CategoryRules,
  type ResolvedFacet,
} from '@clowe/shared';
import { prisma } from '../db';
import { getSettings } from './settingsService';

/**
 * Category rules: the per-department behaviour (option axes, spec sheet,
 * try-on, GST default, return window) lives on the category tree and is
 * inherited downwards. This module resolves it for any category and caches
 * the (small) tree for a few seconds so hot paths don't re-read it.
 */

const RULE_SELECT = {
  id: true,
  parentId: true,
  slug: true,
  name: true,
  isActive: true,
  variantAxes: true,
  attributeSchema: true,
  tryOnEligible: true,
  sizeGuide: true,
  taxRule: true,
  defaultTaxRatePercent: true,
  hsnCode: true,
  returnWindowDays: true,
  facets: true,
} satisfies Prisma.CategorySelect;

export type CategoryRuleRow = Prisma.CategoryGetPayload<{ select: typeof RULE_SELECT }>;

const TTL_MS = 5000;
let cache: { rows: Map<string, CategoryRuleRow>; expires: number } | null = null;

/** Every category (active or not), keyed by id. */
export async function categoryRows(): Promise<Map<string, CategoryRuleRow>> {
  if (cache && cache.expires > Date.now()) return cache.rows;
  const rows = await prisma.category.findMany({ select: RULE_SELECT });
  cache = { rows: new Map(rows.map((r) => [r.id, r])), expires: Date.now() + TTL_MS };
  return cache.rows;
}

/** Call after an admin edits a category so the next read sees it. */
export function invalidateCategoryRules(): void {
  cache = null;
}

/** [category, parent, …, root] — empty when the id is unknown. */
export function chainOf<T extends { id: string; parentId: string | null }>(
  rows: Map<string, T>,
  categoryId: string,
): T[] {
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = rows.get(categoryId);
  while (current && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = current.parentId ? rows.get(current.parentId) : undefined;
  }
  return chain;
}

/** The raw rule columns any category row carries. */
export type RuleColumns = Parameters<typeof categoryRuleFieldsFromRow>[0];

export function ownRuleFields(row: RuleColumns): CategoryRuleFields {
  return categoryRuleFieldsFromRow(row);
}

export function rulesFromChain(chain: RuleColumns[]): CategoryRules {
  return resolveCategoryRules(chain.map(categoryRuleFieldsFromRow));
}

export interface ResolvedCategory {
  rules: CategoryRules;
  /** Top-level ancestor (or the category itself). */
  rootId: string;
  rootSlug: string;
  rootName: string;
  /** Root → … → category. */
  path: { id: string; name: string; slug: string }[];
  depth: number;
}

export async function resolveCategory(categoryId: string): Promise<ResolvedCategory> {
  const rows = await categoryRows();
  const chain = chainOf(rows, categoryId);
  const root = chain[chain.length - 1];
  return {
    rules: rulesFromChain(chain),
    rootId: root?.id ?? categoryId,
    rootSlug: root?.slug ?? '',
    rootName: root?.name ?? '',
    path: [...chain].reverse().map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
    depth: Math.max(0, chain.length - 1),
  };
}

/** A category's filter facets: its ancestors' sets with each level's edits applied. */
export function facetsFromChain(chain: { id: string; facets: unknown }[]): ResolvedFacet[] {
  return resolveFacets([...chain].reverse().map((c) => ({ id: c.id, config: facetConfigFromJson(c.facets) })));
}

export async function facetsFor(categoryId: string): Promise<ResolvedFacet[]> {
  return facetsFromChain(chainOf(await categoryRows(), categoryId));
}

/**
 * Keys an admin hid anywhere up a category's chain. They stay off the rail
 * even when the variants carry them, rather than coming back as an option axis
 * offered automatically.
 */
export async function hiddenFacetKeysMap(categoryIds: Iterable<string>): Promise<Map<string, Set<string>>> {
  const rows = await categoryRows();
  const out = new Map<string, Set<string>>();
  for (const id of categoryIds) {
    if (out.has(id)) continue;
    out.set(id, new Set(chainOf(rows, id).flatMap((c) => facetConfigFromJson(c.facets)?.hide ?? [])));
  }
  return out;
}

/** Facets for many categories at once (one tree read). */
export async function facetsMap(categoryIds: Iterable<string>): Promise<Map<string, ResolvedFacet[]>> {
  const rows = await categoryRows();
  const out = new Map<string, ResolvedFacet[]>();
  for (const id of categoryIds) {
    if (!out.has(id)) out.set(id, facetsFromChain(chainOf(rows, id)));
  }
  return out;
}

export async function categoryRulesFor(categoryId: string): Promise<CategoryRules> {
  return (await resolveCategory(categoryId)).rules;
}

/** Resolve rules for many categories at once (one tree read). */
export async function categoryRulesMap(categoryIds: Iterable<string>): Promise<Map<string, CategoryRules>> {
  const rows = await categoryRows();
  const out = new Map<string, CategoryRules>();
  for (const id of categoryIds) {
    if (!out.has(id)) out.set(id, rulesFromChain(chainOf(rows, id)));
  }
  return out;
}

/** The category itself plus every descendant, any depth. */
export async function descendantIds(categoryId: string): Promise<string[]> {
  const rows = await categoryRows();
  const byParent = new Map<string | null, CategoryRuleRow[]>();
  for (const row of rows.values()) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  const out: string[] = [];
  const stack = [categoryId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    for (const child of byParent.get(id) ?? []) stack.push(child.id);
  }
  return out;
}

/**
 * Return window for an item sold now: the seller's own policy if set, else
 * the category rule, else the platform setting. Checkout stores the answer on
 * each order line; after that, read it with orderLineReturnWindowDays.
 */
export async function returnWindowDaysFor(
  categoryId: string,
  sellerDays: number | null | undefined,
): Promise<number> {
  if (sellerDays != null) return sellerDays;
  const rules = await categoryRulesFor(categoryId);
  if (rules.returnWindowDays != null) return rules.returnWindowDays;
  const settings = await getSettings();
  return settings.returnWindowDays;
}

/** The window each product would be sold with right now, for checkout to store. */
export async function saleReturnWindows(productIds: string[]): Promise<Map<string, number>> {
  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(productIds)] } },
    select: { id: true, categoryId: true, seller: { select: { returnWindowDays: true } } },
  });
  const out = new Map<string, number>();
  for (const p of products) {
    out.set(p.id, await returnWindowDaysFor(p.categoryId, p.seller.returnWindowDays));
  }
  return out;
}

/**
 * The window an order line was sold with. Lines from checkout carry it; a
 * line written some other way (tests) falls back to today's rule.
 */
export async function orderLineReturnWindowDays(line: {
  returnWindowDays: number | null;
  product: { categoryId: string };
  seller: { returnWindowDays: number | null };
}): Promise<number> {
  return line.returnWindowDays ?? returnWindowDaysFor(line.product.categoryId, line.seller.returnWindowDays);
}
