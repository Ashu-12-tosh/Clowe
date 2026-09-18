import { z } from 'zod';
import type { SearchChip } from './searchQuery';

/**
 * Search-as-you-type suggestions.
 *
 * A different job from the results page: this fires on every keystroke, so it
 * matches on prefixes rather than running full-text ranking, and it is capped
 * hard enough that the dropdown stays scannable.
 */

export const suggestQuerySchema = z.object({
  /**
   * Partial text. One character is enough to get suggestions.
   *
   * Deliberately NOT trimmed. A trailing space is the only signal that the last
   * word is finished, and the parser needs it: "best" is still being typed and
   * keeps its letters as a prefix, while "best " is a finished intent word and
   * becomes a sort. Trimming here would erase that distinction before anything
   * could act on it.
   */
  q: z.string().max(100).default(''),
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

/**
 * What the parser made of the query, for the dropdown to show.
 *
 * Without this the shopper types "phone under 15k", sees phones, and has no
 * idea where "under 15k" went — the same unexplained substitution the results
 * page shows chips to avoid.
 */
export interface SuggestUnderstood {
  /** Same chips, same wording, as the results page — both call describeParsedQuery. */
  chips: SearchChip[];
  /**
   * Heading for the product group when those products are not a text match.
   *
   * "best" leaves nothing to prefix-match on, so the group is the top-rated
   * products the query actually asked for, and it says so rather than sitting
   * under a "Products" heading that would imply it matched the letters.
   */
  productsLabel: string | null;
}

/**
 * A whole search, offered as a completion of what was typed — Amazon's
 * "best" -> "best phone under 20k".
 */
export interface QuerySuggestion {
  /** The phrase, lowercase, exactly as it will be searched. */
  text: string;
  /**
   * 'logged': shoppers searched it, often enough and with results.
   * 'catalog': built from the catalog. Either way it was run through the
   * results page's own search before being offered, and came back non-empty.
   */
  source: 'logged' | 'catalog';
}

export interface SuggestResponse {
  /** Echo of what was searched, so a stale response can be discarded. */
  q: string;
  /** Searches that complete the typed text, best first. Shown above products. */
  queries: QuerySuggestion[];
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
  /** null when the query parsed into nothing but literal text. */
  understood: SuggestUnderstood | null;
}

/** Each group is capped so the dropdown stays scannable on a phone. */
export const SUGGEST_GROUP_LIMIT = 5;

/** Query suggestions get a little more room: on Amazon they are most of the list. */
export const QUERY_SUGGESTION_LIMIT = 6;

/**
 * Typed text in the form query suggestions are matched against.
 *
 * Lowercased with whitespace runs collapsed, like the search log — but one
 * trailing space is kept. It is the only sign the last word is finished, and
 * "best " should complete to "best phone" without also offering "bestseller".
 */
export function normalizeSuggestInput(raw: string): string {
  return (raw ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/^ /, '');
}

/**
 * Split a suggested phrase into the part the shopper typed and the part being
 * suggested, so the dropdown can draw the first plain and the second bold.
 *
 * The typed part is sliced from the phrase itself rather than echoed from the
 * input, so whatever casing or spacing was typed, the row reads as one phrase.
 */
export function splitCompletion(phrase: string, typed: string): { typed: string; completion: string } {
  const prefix = normalizeSuggestInput(typed);
  if (prefix && phrase.startsWith(prefix)) {
    return { typed: phrase.slice(0, prefix.length), completion: phrase.slice(prefix.length) };
  }
  return { typed: '', completion: phrase };
}
