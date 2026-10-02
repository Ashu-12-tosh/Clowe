import { prisma } from '../db';
import { isLiveBrand, liveBrands } from './productSearch';

/**
 * Which brands may be shown, and to whom.
 *
 * A Brand row can exist with nothing behind it worth showing: the brand
 * backfill made one for every name a seller typed, so a draft listing branded
 * "t shirt" became a brand. Shoppers see a brand only when it has at least
 * one live product; sellers are offered those, plus brands an admin created
 * that have no products at all yet. A brand whose only listings are drafts,
 * rejected or archived is offered to nobody.
 */

/** Brands to suggest to a seller typing `q`: live ones, and admin-created ones with no products yet. */
export async function brandSuggestions(q: string, limit = 12): Promise<{ id: string; name: string }[]> {
  const [brands, live] = await Promise.all([
    prisma.brand.findMany({
      where: { isActive: true, ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}) },
      select: { id: true, name: true, _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
    }),
    liveBrands(),
  ]);
  const needle = q.toLowerCase();
  return brands
    .filter((b) => isLiveBrand(b, live) || b._count.products === 0)
    // Names that start with what was typed first.
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
    .slice(0, limit)
    .map((b) => ({ id: b.id, name: b.name }));
}

/**
 * Point a listing at the Brand row its name matches, ignoring case, so
 * "zephyr" is saved as Zephyr and linked; a brand picked by id takes that
 * brand's own spelling. A new name is kept as typed, unlinked, for review.
 */
export async function linkBrand<T extends { brand?: string; brandId?: string }>(input: T): Promise<T> {
  if (input.brandId) {
    const brand = await prisma.brand.findUnique({ where: { id: input.brandId }, select: { id: true, name: true } });
    return brand ? { ...input, brand: brand.name } : { ...input, brandId: undefined };
  }
  const name = input.brand?.trim();
  if (!name) return input;
  const match = await prisma.brand.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  return match ? { ...input, brand: match.name, brandId: match.id } : input;
}
