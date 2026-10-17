import type { BrandAuthStatus, Prisma } from '@prisma/client';
import type { BrandAuthView } from '@clowe/shared';
import { prisma } from '../db';
import { resolveFileUrl } from './assets';

/**
 * Brand authorization (owner's rule): an admin marks a brand "authorization
 * required" (Admin → Brands). A listing of that brand — linked to the Brand
 * row, or carrying its name in any case — stays hidden from shoppers until
 * the seller uploads a brand authorization document for it and an admin
 * approves that document. Nothing is deleted; approval brings it back.
 */

export interface AuthBrands {
  ids: string[];
  names: string[];
}

/** The brands that need a document. */
export async function brandsRequiringAuthorization(): Promise<AuthBrands> {
  const rows = await prisma.brand.findMany({ where: { authorizationRequired: true }, select: { id: true, name: true } });
  return { ids: rows.map((r) => r.id), names: rows.map((r) => r.name) };
}

/** Products of those brands, linked by id or by name (any case). */
export function authBrandWhere(b: AuthBrands): Prisma.ProductWhereInput | null {
  if (b.ids.length === 0 && b.names.length === 0) return null;
  return {
    OR: [
      ...(b.ids.length ? [{ brandId: { in: b.ids } }] : []),
      ...b.names.map((name) => ({ brand: { equals: name.trim(), mode: 'insensitive' as const } })),
    ],
  };
}

/** Listings shoppers must not see: an authorization-required brand without an approved document. */
export async function brandAuthHiddenProductIds(): Promise<Set<string>> {
  const where = authBrandWhere(await brandsRequiringAuthorization());
  if (!where) return new Set();
  const rows = await prisma.product.findMany({ where: { AND: [where, { brandAuthStatus: { not: 'APPROVED' } }] }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

type BrandOf = { brand: string | null; brandId: string | null };
const sameBrand = (a: BrandOf, b: BrandOf) =>
  (a.brandId ?? null) === (b.brandId ?? null) && (a.brand?.trim().toLowerCase() ?? '') === (b.brand?.trim().toLowerCase() ?? '');

/** A new brand needs its own document: the earlier one, and its approval, no longer count. */
export function brandAuthResetIfChanged(before: BrandOf, after: BrandOf) {
  return sameBrand(before, after)
    ? {}
    : { brandAuthDoc: null, brandAuthStatus: 'NONE' as const, brandAuthNote: null, brandAuthSubmittedAt: null, brandAuthReviewedAt: null };
}

/** Whether a listing's brand is one of `b` (loaded once for a list). */
export function needsAuthorizationIn(b: AuthBrands, p: BrandOf): boolean {
  if (p.brandId && b.ids.includes(p.brandId)) return true;
  const name = p.brand?.trim().toLowerCase();
  return !!name && b.names.some((n) => n.trim().toLowerCase() === name);
}

/** Whether this listing's brand needs a document. */
export async function brandNeedsAuthorization(p: BrandOf): Promise<boolean> {
  return needsAuthorizationIn(await brandsRequiringAuthorization(), p);
}

type BrandAuthRow = BrandOf & {
  brandAuthDoc: string | null;
  brandAuthStatus: BrandAuthStatus;
  brandAuthNote: string | null;
  brandAuthSubmittedAt: Date | null;
  brandAuthReviewedAt: Date | null;
};

/** The listing's brand authorization as the seller and admins see it; null when its brand needs none. */
export async function brandAuthView(p: BrandAuthRow, b?: AuthBrands): Promise<BrandAuthView | null> {
  if (!needsAuthorizationIn(b ?? (await brandsRequiringAuthorization()), p)) return null;
  return {
    status: p.brandAuthStatus,
    docUrl: await resolveFileUrl(p.brandAuthDoc),
    note: p.brandAuthNote,
    submittedAt: p.brandAuthSubmittedAt?.toISOString() ?? null,
    reviewedAt: p.brandAuthReviewedAt?.toISOString() ?? null,
  };
}
