import type { Prisma, SellerBrandProof } from '@prisma/client';
import type { BrandAuthStatus, BrandAuthView, BrandProofType } from '@clowe/shared';
import { prisma } from '../db';
import { resolveFileUrl } from './assets';

/**
 * Brand proof (owner's rule): an admin marks a brand "authorization required"
 * (Admin → Brands). A seller's listings of that brand — linked to the Brand
 * row, or carrying its name in any case — stay hidden from shoppers until the
 * seller uploads a brand proof (an authorization letter, or a GST purchase
 * invoice from the brand or its authorized distributor) and an admin approves
 * it. One approval covers all that seller's listings of the brand until its
 * optional expiry. Nothing is deleted; approval brings the listings back.
 */

export interface AuthBrands {
  ids: string[];
  names: string[];
  /** Lower-case name → brand id, to place a listing that carries only the name. */
  idByName: Map<string, string>;
  nameById: Map<string, string>;
}

/** The brands that need proof. */
export async function brandsRequiringAuthorization(): Promise<AuthBrands> {
  const rows = await prisma.brand.findMany({ where: { authorizationRequired: true }, select: { id: true, name: true } });
  return {
    ids: rows.map((r) => r.id),
    names: rows.map((r) => r.name),
    idByName: new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id])),
    nameById: new Map(rows.map((r) => [r.id, r.name])),
  };
}

/** Products of those brands, linked by id or by name (any case). */
export function authBrandWhere(b: AuthBrands): Prisma.ProductWhereInput | null {
  if (b.ids.length === 0) return null;
  return {
    OR: [{ brandId: { in: b.ids } }, ...b.names.map((name) => ({ brand: { equals: name.trim(), mode: 'insensitive' as const } }))],
  };
}

type BrandOf = { brand: string | null; brandId: string | null };

/** The authorization-required brand a listing belongs to, or null. */
export function authBrandIdOf(b: AuthBrands, p: BrandOf): string | null {
  if (p.brandId && b.ids.includes(p.brandId)) return p.brandId;
  const name = p.brand?.trim().toLowerCase();
  return (name && b.idByName.get(name)) || null;
}

const approvedNow = (proof: Pick<SellerBrandProof, 'status' | 'expiresAt'>, now = new Date()) =>
  proof.status === 'APPROVED' && (!proof.expiresAt || proof.expiresAt > now);

/** Listings shoppers must not see: an authorization-required brand without an approved, unexpired proof from its seller. */
export async function brandAuthHiddenProductIds(): Promise<Set<string>> {
  const b = await brandsRequiringAuthorization();
  const where = authBrandWhere(b);
  if (!where) return new Set();
  const [products, proofs] = await Promise.all([
    prisma.product.findMany({ where, select: { id: true, sellerId: true, brand: true, brandId: true } }),
    prisma.sellerBrandProof.findMany({ where: { brandId: { in: b.ids }, status: 'APPROVED' }, select: { sellerId: true, brandId: true, status: true, expiresAt: true } }),
  ]);
  const ok = new Set(proofs.filter((p) => approvedNow(p)).map((p) => `${p.sellerId}:${p.brandId}`));
  const hidden = new Set<string>();
  for (const p of products) {
    const brandId = authBrandIdOf(b, p);
    if (brandId && !ok.has(`${p.sellerId}:${brandId}`)) hidden.add(p.id);
  }
  return hidden;
}

/** Whether a listing's brand needs proof. */
export async function brandNeedsAuthorization(p: BrandOf): Promise<boolean> {
  return authBrandIdOf(await brandsRequiringAuthorization(), p) !== null;
}

/** Where a seller's proof for a brand stands, as one status. */
export function proofStatus(proof: Pick<SellerBrandProof, 'status' | 'expiresAt'> | null, now = new Date()): BrandAuthStatus {
  if (!proof) return 'NONE';
  if (proof.status === 'APPROVED') return approvedNow(proof, now) ? 'APPROVED' : 'EXPIRED';
  return proof.status;
}

const day = (d: Date | null) => (d ? new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10) : null);

/** A seller's proof for a brand, as the seller and admins see it. */
export async function brandProofView(brandId: string, brandName: string, proof: SellerBrandProof | null, withDoc = true): Promise<BrandAuthView> {
  return {
    brandId,
    brandName,
    status: proofStatus(proof),
    proofType: (proof?.proofType as BrandProofType | undefined) ?? null,
    docUrl: withDoc && proof ? await resolveFileUrl(proof.doc) : null,
    note: proof?.note ?? null,
    submittedAt: proof?.submittedAt.toISOString() ?? null,
    reviewedAt: proof?.reviewedAt?.toISOString() ?? null,
    expiresAt: day(proof?.expiresAt ?? null),
  };
}

/** For listings of one seller: each listing's brand proof (null when its brand needs none). */
export async function brandAuthForListings(
  sellerId: string,
  listings: (BrandOf & { id: string })[],
  opts: { withDoc?: boolean; b?: AuthBrands } = {},
): Promise<Map<string, BrandAuthView | null>> {
  const b = opts.b ?? (await brandsRequiringAuthorization());
  const out = new Map<string, BrandAuthView | null>();
  if (b.ids.length === 0) {
    for (const l of listings) out.set(l.id, null);
    return out;
  }
  const proofs = await prisma.sellerBrandProof.findMany({ where: { sellerId, brandId: { in: b.ids } } });
  const byBrand = new Map(proofs.map((p) => [p.brandId, p]));
  const views = new Map<string, BrandAuthView>();
  for (const l of listings) {
    const brandId = authBrandIdOf(b, l);
    if (!brandId) {
      out.set(l.id, null);
      continue;
    }
    if (!views.has(brandId)) views.set(brandId, await brandProofView(brandId, b.nameById.get(brandId)!, byBrand.get(brandId) ?? null, opts.withDoc ?? true));
    out.set(l.id, views.get(brandId)!);
  }
  return out;
}
