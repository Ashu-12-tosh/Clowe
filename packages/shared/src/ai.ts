import { z } from 'zod';

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const reviewCreateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
export type ReviewCreateInput = z.infer<typeof reviewCreateSchema>;

export interface ReviewItem {
  id: string;
  rating: number;
  comment: string | null;
  userName: string;
  isMine: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// AI: product description generator (seller)
// ---------------------------------------------------------------------------

export const aiDescriptionSchema = z.object({
  title: z.string().trim().min(3).max(120),
  brand: z.string().trim().max(40).optional(),
  categoryName: z.string().trim().max(60).optional(),
  /** Free-form basics: fabric, fit, occasion… */
  keywords: z.string().trim().max(200).optional(),
});
export type AiDescriptionInput = z.infer<typeof aiDescriptionSchema>;

// ---------------------------------------------------------------------------
// AI: review summary (product page)
// ---------------------------------------------------------------------------

export interface ReviewSummaryView {
  summary: string | null; // null when too few reviews
  ratingAvg: number | null;
  ratingCount: number;
  provider: string;
}

// ---------------------------------------------------------------------------
// AI: voice search intent
// ---------------------------------------------------------------------------

export const searchIntentSchema = z.object({
  transcript: z.string().trim().min(2).max(200),
});

/** Structured filters extracted from a spoken query. */
export interface SearchIntent {
  q: string;
  category: string | null; // category slug
  maxPrice: number | null; // rupees
  colors: string[];
}

// ---------------------------------------------------------------------------
// AI: support chat
// ---------------------------------------------------------------------------

export const supportChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(1000),
      }),
    )
    .min(1)
    .max(20),
});
export type SupportChatInput = z.infer<typeof supportChatSchema>;
