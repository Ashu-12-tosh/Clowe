'use client';

/**
 * What the search understood, shown above the results.
 *
 * Three jobs, all of them about not making the shopper guess:
 *
 *   Chips for what was parsed out of the words, each removable.
 *   A notice when filters had to be loosened to return anything.
 *   A note when results came from outside the category the words implied.
 *
 * Removing a chip does NOT rewrite the query into explicit filters. The raw
 * text is sent back untouched and the dismissed keys travel in `drop`, so the
 * server re-parses and removes exactly what was dismissed. That distinction is
 * the whole point: a category the words imply is a guess that may only rank,
 * and turning it into a filter here would hide the products that live in a
 * second category tree — the bug this design exists to prevent.
 */

import type { SearchDroppable, SearchMeta } from '@clowe/shared';
import { formatPaise } from '@/lib/format';

interface Chip {
  key: SearchDroppable;
  label: string;
  /** Inferred chips carry a hint that they widen rather than narrow. */
  hint?: string;
}

const SORT_LABELS: Record<string, string> = {
  rating: 'Top rated',
  popularity: 'Popular',
  price_asc: 'Cheapest first',
  price_desc: 'Most expensive first',
  newest: 'Newest',
};

export default function SearchSummary({
  meta,
  dropped,
  categoryName,
  onDrop,
  onClearAll,
}: {
  meta: SearchMeta;
  /** Keys already dismissed, so their chips stay gone across a re-render. */
  dropped: SearchDroppable[];
  /** Display name for the inferred category slug, resolved by the caller. */
  categoryName: string | null;
  onDrop: (key: SearchDroppable) => void;
  onClearAll: () => void;
}) {
  const { filters, sort } = meta.parsed;
  const chips: Chip[] = [];

  if (filters.inferredCategorySlug && !dropped.includes('category')) {
    chips.push({
      key: 'category',
      label: categoryName ?? filters.inferredCategorySlug,
      hint: 'ranked first, not filtered',
    });
  }
  if (filters.maxPricePaise != null && !dropped.includes('maxPrice')) {
    chips.push({ key: 'maxPrice', label: `Under ${formatPaise(filters.maxPricePaise)}` });
  }
  if (filters.minPricePaise != null && !dropped.includes('minPrice')) {
    chips.push({ key: 'minPrice', label: `Over ${formatPaise(filters.minPricePaise)}` });
  }
  if (filters.brands.length > 0 && !dropped.includes('brands')) {
    chips.push({ key: 'brands', label: filters.brands.join(', ') });
  }
  if (filters.onSale && !dropped.includes('onSale')) {
    chips.push({ key: 'onSale', label: 'On sale' });
  }
  if (sort && !dropped.includes('sort')) {
    chips.push({ key: 'sort', label: SORT_LABELS[sort] ?? sort });
  }

  const hasNotice = meta.relaxed !== null || meta.outsideInferredCategory > 0;
  if (chips.length === 0 && !hasNotice) return null;

  return (
    <div className="mb-4 space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">From your search:</span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => onDrop(chip.key)}
              title={chip.hint ? `${chip.label} — ${chip.hint}. Tap to remove.` : `Remove ${chip.label}`}
              className="group inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 py-1 pl-3 pr-2 text-xs font-semibold text-brand-700 transition hover:border-brand-600"
            >
              {chip.label}
              <span aria-hidden className="text-sm leading-none text-brand-400 group-hover:text-brand-700">
                ×
              </span>
              <span className="sr-only">Remove this filter</span>
            </button>
          ))}
          {chips.length > 1 && (
            <button
              onClick={onClearAll}
              className="text-xs font-semibold text-gray-500 hover:text-ink-900 hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {meta.relaxed && (
        // Never substitute quietly: if the filters were loosened, say so.
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {meta.relaxed.message}
        </p>
      )}

      {meta.outsideInferredCategory > 0 && (
        // A phone search can surface something filed under Electronics. That is
        // correct, and unexplained it looks like a bug.
        <p className="text-xs text-gray-500">
          {meta.outsideInferredCategory} result{meta.outsideInferredCategory === 1 ? '' : 's'} on this
          page {meta.outsideInferredCategory === 1 ? 'sits' : 'sit'} outside{' '}
          {categoryName ?? 'the matched category'}, shown because they match what you searched for.
        </p>
      )}
    </div>
  );
}
