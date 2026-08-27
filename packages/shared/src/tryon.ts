import { z } from 'zod';

export const tryOnRequestSchema = z.object({
  productId: z.string().min(1),
  /** Public URL of the customer's photo (from POST /api/uploads). */
  photoUrl: z.string().url(),
  /** Size/colour on screen when the run was made — shown on the result. */
  variantSize: z.string().trim().max(40).optional(),
  variantColor: z.string().trim().max(40).optional(),
});
export type TryOnRequestInput = z.infer<typeof tryOnRequestSchema>;

export interface TryOnResult {
  id: string;
  status: 'SUCCESS' | 'FAILED';
  resultImageUrl: string | null;
  errorMessage: string | null;
  provider: string;
  costPaise: number;
  /** Try-ons remaining today for this user. */
  remainingToday: number;
}

/** Max upload size the API accepts for a try-on photo, in bytes. */
export const TRYON_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export const TRYON_FEEDBACK = ['UP', 'DOWN'] as const;
export type TryOnFeedback = (typeof TRYON_FEEDBACK)[number];

export const tryOnFeedbackSchema = z.object({ feedback: z.enum(TRYON_FEEDBACK).nullable() });

export interface TryOnHistoryRow {
  id: string;
  productId: string;
  productTitle: string;
  productSlug: string;
  inputImageUrl: string;
  resultImageUrl: string | null;
  status: string;
  provider: string;
  /** Shopper's verdict on the fit, when they rated it. */
  feedback: TryOnFeedback | null;
  variantSize: string | null;
  variantColor: string | null;
  createdAt: string;
}

export interface TryOnQuota {
  dailyLimit: number;
  usedToday: number;
  provider: string;
  /** The user's saved try-on photo (uploaded once, reused automatically). */
  savedPhotoUrl: string | null;
}

export const saveTryOnPhotoSchema = z.object({
  photoUrl: z.string().url(),
});
