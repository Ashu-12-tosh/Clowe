import { z } from 'zod';

/**
 * Search-as-you-type suggestions.
 *
 * A different job from the results page: this fires on every keystroke, so it
 * matches on prefixes rather than running full-text ranking, and it is capped
 * hard enough that the dropdown stays scannable.
 */

export const suggestQuerySchema = z.object({
  /** Partial text. One character is enough to get suggestions. */
  q: z.string().trim().max(100).default(''),
});
export type SuggestQuery = z.infer<typeof suggestQuerySchema>;

export interface ProductSuggestion {
  id: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  /** Cheapest variant, in paise. */
  pricePaise: number;
}

export interface CategorySuggestion {
  slug: string;
  name: string;
  /**
   * Parent category name, or null for a root.
   *
   * The catalog can hold two categories with the same name under different
   * parents — there are currently two called "Smartphones". Without the parent
   * the dropdown shows the same word twice and looks broken, so the UI renders
   * this as "Smartphones in Electronics".
   */
  parentName: string | null;
}

export interface BrandSuggestion {
  name: string;
}

export interface SuggestResponse {
  /** Echo of what was searched, so a stale response can be discarded. */
  q: string;
  products: ProductSuggestion[];
  categories: CategorySuggestion[];
  brands: BrandSuggestion[];
  /**
   * Best sellers, for the dropdown's empty state.
   *
   * Deliberately products and not "popular searches": nothing records what
   * people search for yet, and a hand-written list of plausible queries would
   * look like real data while never changing. Once search queries are logged,
   * a genuine popular-queries group can be added beside this one.
   */
  trending: ProductSuggestion[];
}

/** Each group is capped so the dropdown stays scannable on a phone. */
export const SUGGEST_GROUP_LIMIT = 5;
