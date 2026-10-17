import { z } from 'zod';
import { assetRefSchema } from './assets';

// ---------------------------------------------------------------------------
// Brand authorization (owner's rule)
//
// An admin marks a brand "authorization required" (Admin → Brands). Its
// listings stay hidden from shoppers until the seller uploads a brand
// authorization document for the listing and an admin approves it.
// ---------------------------------------------------------------------------

export const BRAND_AUTH_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type BrandAuthStatus = (typeof BRAND_AUTH_STATUSES)[number];

export const BRAND_AUTH_LABELS: Record<BrandAuthStatus, string> = {
  NONE: 'Brand authorization needed — hidden from shoppers',
  PENDING: 'Brand authorization waiting for review — hidden from shoppers',
  APPROVED: 'Brand authorization approved',
  REJECTED: 'Brand authorization rejected — hidden from shoppers',
};

/** A listing's brand authorization, for a brand that needs one (null otherwise). */
export interface BrandAuthView {
  status: BrandAuthStatus;
  /** A link to the document, for the seller and admins. */
  docUrl: string | null;
  /** The admin's note on a rejection. */
  note: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
}

/** PUT /api/seller/products/:id/brand-authorization — the uploaded document (POST /api/uploads/seller-document). */
export const brandAuthSubmitSchema = z.object({ doc: assetRefSchema });

/** POST /api/admin/products/:id/brand-authorization */
export const brandAuthDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(300).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'REJECT' && (v.note ?? '').length < 5) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'Say why it is rejected (at least 5 characters), so the seller knows what to send' });
    }
  });
export type BrandAuthDecisionInput = z.infer<typeof brandAuthDecisionSchema>;
