'use client';

import { useState } from 'react';
import type { FacetRail, RailFacet, RailValue } from '@clowe/shared';
import PriceRangeSlider from '@/components/PriceRangeSlider';

/** Values shown before "Show more". */
const PREVIEW = 6;
/** Sections open on arrival; the rest open on a tap. Selected ones are always open. */
const OPEN_ON_ARRIVAL = 6;
/** A brand list longer than this gets a search box. */
const BRAND_SEARCH_FROM = 8;

interface Props {
  rail: FacetRail;
  onToggle: (facet: RailFacet, value: string) => void;
  onPrice: (min: number | null, max: number | null) => void;
  /** Rendered first: the category list, where a page has one. */
  before?: React.ReactNode;
}

function Section({ title, open: initial, children }: { title: string; open: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="border-b border-gray-100 py-3.5" data-rail-section={title}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-sm font-bold text-ink-900"
      >
        {title}
        <span className={`text-xs text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-gray-400">{n.toLocaleString('en-IN')}</span>;
}

/** A tick-box row: the value, and how many products it would leave. */
function CheckRow({ value, onClick, radio = false }: { value: RailValue; onClick: () => void; radio?: boolean }) {
  const dead = value.count === 0 && !value.selected;
  return (
    <li>
      <label className={`flex cursor-pointer items-center gap-2.5 text-sm ${dead ? 'opacity-40' : ''}`}>
        <input
          type={radio ? 'radio' : 'checkbox'}
          checked={value.selected}
          onChange={onClick}
          onClick={radio && value.selected ? onClick : undefined}
          disabled={dead}
          className="h-4 w-4 shrink-0 accent-brand-600"
        />
        <span className={`min-w-0 break-words ${value.selected ? 'font-semibold text-ink-900' : 'text-gray-700'}`}>{value.label}</span>
        <Count n={value.count} />
      </label>
    </li>
  );
}

function ValueList({ facet, onToggle }: { facet: RailFacet; onToggle: Props['onToggle'] }) {
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState('');
  const searchable = facet.key === 'brand' && facet.values.length > BRAND_SEARCH_FROM;
  const matching = query ? facet.values.filter((v) => v.label.toLowerCase().includes(query.trim().toLowerCase())) : facet.values;
  // Chosen values always show, even past the preview.
  const shown = all || query ? matching : matching.filter((v, i) => i < PREVIEW || v.selected);
  const hidden = matching.length - shown.length;

  if (facet.kind === 'size') {
    return (
      <div className="flex flex-wrap gap-1.5">
        {facet.values.map((v) => (
          <button
            key={v.value}
            type="button"
            onClick={() => onToggle(facet, v.value)}
            disabled={v.count === 0 && !v.selected}
            aria-pressed={v.selected}
            className={`rounded-md border px-2.5 py-1 text-xs disabled:opacity-40 ${
              v.selected ? 'border-brand-600 bg-brand-100 font-semibold text-brand-700' : 'border-gray-300 text-gray-700 hover:border-brand-600'
            }`}
          >
            {v.label} <span className="text-gray-400">{v.count}</span>
          </button>
        ))}
      </div>
    );
  }

  if (facet.kind === 'color') {
    return (
      <ul className="grid grid-cols-2 gap-x-3 gap-y-2">
        {facet.values.map((v) => (
          <li key={v.value}>
            <button
              type="button"
              onClick={() => onToggle(facet, v.value)}
              disabled={v.count === 0 && !v.selected}
              aria-pressed={v.selected}
              title={v.members?.length ? v.members.join(', ') : v.label}
              className="flex w-full items-center gap-2 text-left text-sm disabled:opacity-40"
            >
              <span
                className={`h-5 w-5 shrink-0 rounded-full border ${v.selected ? 'border-brand-600 ring-2 ring-brand-200' : 'border-gray-300'}`}
                style={
                  v.swatch
                    ? { backgroundColor: v.swatch }
                    : { background: 'conic-gradient(#dc2626, #eab308, #16a34a, #3b82f6, #9333ea, #dc2626)' }
                }
              />
              <span className={`min-w-0 truncate ${v.selected ? 'font-semibold text-ink-900' : 'text-gray-700'}`}>{v.label}</span>
              <Count n={v.count} />
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      {searchable && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search brands…"
          aria-label="Search brands"
          className="mb-2.5 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-brand-600"
        />
      )}
      <ul className="space-y-2">
        {shown.map((v) => (
          <CheckRow key={v.value} value={v} radio={!facet.multi} onClick={() => onToggle(facet, v.value)} />
        ))}
        {matching.length === 0 && <li className="text-xs text-gray-400">Nothing matches “{query}”.</li>}
      </ul>
      {(hidden > 0 || all) && !query && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-2 text-xs font-semibold text-brand-600 hover:underline">
          {all ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      )}
    </>
  );
}

/**
 * The filter rail: the facets the API found for this listing, each value
 * with how many products it would leave. Category facets come first, in the
 * order the category sets; brand, rating, discount and availability follow.
 */
export default function FilterRail({ rail, onToggle, onPrice, before }: Props) {
  return (
    <div data-filter-rail>
      {before}
      {rail.price && (
        <Section title="Price" open>
          <PriceRangeSlider price={rail.price} onApply={onPrice} />
        </Section>
      )}
      {rail.facets.map((facet, i) => (
        <Section key={facet.key} title={facet.label} open={i < OPEN_ON_ARRIVAL || facet.values.some((v) => v.selected)}>
          <ValueList facet={facet} onToggle={onToggle} />
        </Section>
      ))}
    </div>
  );
}
