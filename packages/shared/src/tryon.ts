import { z } from 'zod';
import { assetRefSchema } from './assets';

/**
 * Hours a shopper's try-on photo is kept after upload — saved or not — before
 * the API's sweep deletes it (Privacy Policy 3.7, Terms 9.6).
 */
export const TRYON_PHOTO_RETENTION_HOURS = 24;

/** The consent a shopper gives before their first try-on photo, word for word. */
export const TRYON_CONSENT_TEXT = 'I am 18+ and this photo is of me or of an adult who has consented';
/** Stored with the consent, so a change of wording can ask again. */
export const TRYON_CONSENT_VERSION = '2026-10-16';

export const tryOnConsentSchema = z.object({ accepted: z.literal(true) });

export const tryOnRequestSchema = z.object({
  productId: z.string().min(1),
  /** The customer's photo: the reference from POST /api/uploads/private (purpose TRYON_PHOTO). */
  photoRef: assetRefSchema,
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
  /** Null once the photo has passed its retention period. */
  inputImageUrl: string | null;
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
  /** The user's saved try-on photo (uploaded once, reused automatically): a URL to show it… */
  savedPhotoUrl: string | null;
  /** …and the reference to send with a try-on. */
  savedPhotoRef: string | null;
  /** The shopper has given the try-on consent (current wording). */
  consented: boolean;
}

export const saveTryOnPhotoSchema = z.object({
  photoRef: assetRefSchema,
});
