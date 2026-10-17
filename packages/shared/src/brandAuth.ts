import { z } from 'zod';
import { assetRefSchema } from './assets';

// ---------------------------------------------------------------------------
// Brand proof (owner's rule)
//
// An admin marks a brand "authorization required" (Admin → Brands). A seller's
// listings of that brand stay hidden from shoppers until the seller uploads a
// brand proof — an authorization letter from the brand or its authorized
// distributor, or a GST purchase invoice from them — and an admin approves it.
// One approval covers all that seller's listings of the brand, until its
// optional expiry date.
// ---------------------------------------------------------------------------

/** The brands that start out needing proof. Admins edit the list in Admin → Brands. */
export const DEFAULT_AUTHORIZATION_BRANDS = [
  'Apple',
  'Allen Solly',
  'Van Heusen',
  'Louis Philippe',
  'Peter England',
  "Levi's",
  'Nike',
  'Adidas',
  'Puma',
] as const;

export const BRAND_PROOF_TYPES = ['AUTHORIZATION_LETTER', 'PURCHASE_INVOICE'] as const;
export type BrandProofType = (typeof BRAND_PROOF_TYPES)[number];
export const BRAND_PROOF_TYPE_LABELS: Record<BrandProofType, string> = {
  AUTHORIZATION_LETTER: 'Authorization letter (from the brand or its authorized distributor)',
  PURCHASE_INVOICE: 'GST purchase invoice (from the brand or its authorized distributor)',
};
export const BRAND_PROOF_FIELD_LABEL = 'Brand proof (authorization letter or purchase invoice)';

/** NONE: nothing uploaded. EXPIRED: an approval whose expiry date has passed. */
export const BRAND_AUTH_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type BrandAuthStatus = (typeof BRAND_AUTH_STATUSES)[number];

export const BRAND_AUTH_LABELS: Record<BrandAuthStatus, string> = {
  NONE: 'Brand proof needed — hidden from shoppers',
  PENDING: 'Brand proof waiting for review — hidden from shoppers',
  APPROVED: 'Brand proof approved',
  REJECTED: 'Brand proof rejected — hidden from shoppers',
  EXPIRED: 'Brand proof expired — hidden from shoppers',
};

/** A seller's proof for one brand that needs it (null for every other brand). */
export interface BrandAuthView {
  brandId: string;
  brandName: string;
  status: BrandAuthStatus;
  proofType: BrandProofType | null;
  /** A link to the document, for the seller who uploaded it. */
  docUrl: string | null;
  /** The admin's note on a rejection. */
  note: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  /** The approval covers listings until this date (YYYY-MM-DD); null: no expiry. */
  expiresAt: string | null;
}

/** PUT /api/seller/brand-proofs/:brandId — the uploaded document (POST /api/uploads/seller-document). */
export const brandProofSubmitSchema = z.object({
  doc: assetRefSchema,
  proofType: z.enum(BRAND_PROOF_TYPES),
});
export type BrandProofSubmitInput = z.infer<typeof brandProofSubmitSchema>;

/** POST /api/admin/brand-proofs/:id */
export const brandProofDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(300).optional(),
    /** Optional: the approval lapses after this day (YYYY-MM-DD). */
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-31')
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'REJECT' && (v.note ?? '').length < 5) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'Say why it is rejected (at least 5 characters), so the seller knows what to send' });
    }
    if (v.decision === 'APPROVE' && v.expiresAt && new Date(`${v.expiresAt}T23:59:59+05:30`) <= new Date()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'The expiry date must be in the future' });
    }
  });
export type BrandProofDecisionInput = z.infer<typeof brandProofDecisionSchema>;

/** One proof as Admin → Brands lists it. */
export interface AdminBrandProofRow {
  id: string;
  sellerId: string;
  shopName: string;
  brandId: string;
  brandName: string;
  proofType: BrandProofType;
  status: BrandAuthStatus;
  note: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  expiresAt: string | null;
  /** The seller's listings of this brand. */
  listingCount: number;
}
