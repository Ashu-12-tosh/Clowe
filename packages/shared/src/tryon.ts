import { z } from 'zod';

export const tryOnRequestSchema = z.object({
  productId: z.string().min(1),
  /** Public URL of the customer's photo (from POST /api/uploads). */
  photoUrl: z.string().url(),
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

export interface TryOnHistoryRow {
  id: string;
  productId: string;
  productTitle: string;
  productSlug: string;
  inputImageUrl: string;
  resultImageUrl: string | null;
  status: string;
  provider: string;
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
