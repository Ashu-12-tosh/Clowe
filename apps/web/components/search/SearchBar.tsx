'use client';

/**
 * The storefront search box.
 *
 * Three things make a type-ahead feel broken, and each is handled explicitly
 * here rather than left to luck:
 *
 *   Stale responses. Without aborting, a slow reply for "sam" can land after a
 *   fast reply for "samsung" and repaint the dropdown with older results. Every
 *   request aborts the one before it, and the response is checked against the
 *   text that asked for it before it is allowed to render.
 *
 *   Keyboard dead ends. Arrow keys move through every group as one list, so a
 *   shopper never has to know the dropdown is grouped at all.
 *
 *   Injection through highlighting. The matched substring is bolded by slicing
 *   the string at an index, never by building HTML from what was typed.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { splitCompletion, type SuggestResponse } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { clearRecentSearches, getRecentSearches, recordRecentSearch } from '@/lib/recentSearches';

const DEBOUNCE_MS = 200;

/** One row in the flattened list the keyboard walks. */
type Option =
  | { kind: 'query'; label: string; href: string }
  | { kind: 'product'; label: string; href: string; imageUrl: string | null; pricePaise: number }
  | { kind: 'category'; label: string; href: string; parentName: string | null }
  | { kind: 'brand'; label: string; href: string }
  | { kind: 'recent'; label: string; href: string }
  | { kind: 'trending'; label: string; href: string; imageUrl: string | null; pricePaise: number };

const GROUP_LABELS: Record<Option['kind'], string> = {
  // No heading: the magnifier on each row already says these are searches,
  // and Amazon's list reads the same way.
  query: '',
  product: 'Products',
  category: 'Categories',
  brand: 'Brands',
  recent: 'Recent searches',
  trending: 'Popular right now',
};

/** Marks a row as a search to run, not a product to open. */
function MagnifierIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-4 w-4"
    >
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="m13 13 4 4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A query suggestion drawn the way Amazon draws one: what was typed in plain
 * text, the completion in bold, so the eye lands on the part that is new.
 *
 * The inverse of product highlighting, where the bold run is what matched.
 * Slices the phrase rather than echoing the input, so it reads as one phrase
 * whatever casing or spacing was typed, and stays text either way.
 */
function Completion({ phrase, typed }: { phrase: string; typed: string }) {
  const { typed: head, completion } = splitCompletion(phrase, typed);
  return (
    <>
      {head && <span className="text-gray-600">{head}</span>}
      <span className="font-bold text-ink-900">{completion}</span>
    </>
  );
}

/**
 * Bold the matched run without ever building markup from user input.
 *
 * The match is found by index and the string is sliced around it, so whatever
 * was typed stays text. Returning nodes rather than an HTML string is what
 * makes that guarantee structural instead of a matter of remembering to escape.
 */
function Highlighted({ text, match }: { text: string; match: string }) {
  const needle = match.trim().toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-bold text-ink-900">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

export default function SearchBar({
  initialQuery = '',
  onVoiceSearch,
  voiceActive,
  voiceSupported,
}: {
  initialQuery?: string;
  onVoiceSearch?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestResponse | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listboxId = useId();

  // Voice search hands us a transcript through the same input, so the parser
  // and the dropdown treat spoken and typed queries identically.
  useEffect(() => setQuery(initialQuery), [initialQuery]);

  useEffect(() => {
    setRecent(getRecentSearches());
  }, []);

  // -- Fetching -------------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    // Sent untrimmed on purpose. A trailing space is the only signal that the
    // last word is finished, and the parser needs it: "best " is a finished
    // intent word, "best" is four letters someone may still be typing.
    const sent = query;

    const timer = setTimeout(() => {
      // Abort whatever is still in flight. Without this the dropdown can be
      // repainted by a reply to an older keystroke.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);

      api<SuggestResponse>(`/api/search/suggest?q=${encodeURIComponent(sent)}`, {
        signal: controller.signal,
      })
        .then((data) => {
          // Second guard: the server echoes the query it answered, so a reply
          // that raced past an abort still cannot overwrite newer text. Compared
          // exactly, since "best" and "best " are different requests.
          if (controller.signal.aborted || data.q !== sent) return;
          setSuggestions(data);
          setActiveIndex(-1);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, open]);

  // Abort on unmount so a pending request cannot set state on a dead component.
  useEffect(() => () => abortRef.current?.abort(), []);

  // -- Options --------------------------------------------------------------

  const options = useMemo<Option[]>(() => {
    const typed = query.trim();
    const out: Option[] = [];

    if (!typed) {
      // Nothing typed: what this shopper searched before is more useful than
      // what the catalog sells most, so it goes first.
      for (const q of recent) {
        out.push({ kind: 'recent', label: q, href: `/products?q=${encodeURIComponent(q)}` });
      }
      for (const p of suggestions?.trending ?? []) {
        out.push({
          kind: 'trending',
          label: p.title,
          href: `/products/${p.slug}`,
          imageUrl: p.imageUrl,
          pricePaise: p.pricePaise,
        });
      }
      return out;
    }

    // Searches first, products below — the order Amazon uses, because most
    // people typing "best" want a better query more than a specific product.
    for (const s of suggestions?.queries ?? []) {
      out.push({ kind: 'query', label: s.text, href: `/products?q=${encodeURIComponent(s.text)}` });
    }
    for (const p of suggestions?.products ?? []) {
      out.push({
        kind: 'product',
        label: p.title,
        href: `/products/${p.slug}`,
        imageUrl: p.imageUrl,
        pricePaise: p.pricePaise,
      });
    }
    for (const c of suggestions?.categories ?? []) {
      out.push({
        kind: 'category',
        label: c.name,
        href: `/products?category=${encodeURIComponent(c.slug)}`,
        parentName: c.parentName,
      });
    }
    for (const b of suggestions?.brands ?? []) {
      out.push({
        kind: 'brand',
        label: b.name,
        href: `/products?q=${encodeURIComponent(b.name)}`,
      });
    }
    return out;
  }, [query, suggestions, recent]);

  /** What the parser made of the query, for the chips and the product heading. */
  const understood = query.trim() ? (suggestions?.understood ?? null) : null;

  /** Group boundaries, so headings render without breaking the flat index. */
  const rows = useMemo(() => {
    const out: { option: Option; index: number; heading: string | null }[] = [];
    let previous: Option['kind'] | null = null;
    options.forEach((option, index) => {
      // "Products" would imply these matched the letters typed. When the query
      // was all intent — "best" — they did not, and the heading says what they
      // actually are.
      const label =
        option.kind === 'product' && understood?.productsLabel
          ? understood.productsLabel
          : GROUP_LABELS[option.kind];
      out.push({ option, index, heading: option.kind === previous ? null : label });
      previous = option.kind;
    });
    return out;
  }, [options, understood]);

  // -- Actions --------------------------------------------------------------

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const submitRaw = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed) recordRecentSearch(trimmed);
      setRecent(getRecentSearches());
      close();
      inputRef.current?.blur(); // dismisses the on-screen keyboard on mobile
      router.push(trimmed ? `/products?q=${encodeURIComponent(trimmed)}` : '/products');
    },
    [close, router],
  );

  const choose = useCallback(
    (option: Option) => {
      // A chosen suggestion is still a search this shopper made.
      if (option.kind === 'recent' || option.kind === 'brand' || option.kind === 'query') {
        recordRecentSearch(option.label);
      }
      // A chosen search replaces what was typed, so the box shows the search the
      // page is showing rather than the three letters that led to it.
      if (option.kind === 'query' || option.kind === 'recent') setQuery(option.label);
      setRecent(getRecentSearches());
      close();
      inputRef.current?.blur();
      router.push(option.href);
    },
    [close, router],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      // First Escape closes the dropdown; the input keeps what was typed.
      if (open) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key === 'Tab') {
      // Tab is navigation, not selection — let focus leave and get out of the way.
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) {
        setOpen(true);
        return;
      }
      if (options.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // Wraps at both ends, and -1 means "nothing highlighted, use the raw text".
      setActiveIndex((current) => {
        const next = current + step;
        if (next < 0) return options.length - 1;
        if (next >= options.length) return -1;
        return next;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const highlighted = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (highlighted) choose(highlighted);
      else submitRaw(query);
    }
  }

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // Close when focus or a click leaves the whole control.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, close]);

  const typed = query.trim();
  const showDropdown = open && (options.length > 0 || (typed.length > 0 && !loading));

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submitRaw(query);
        }}
      >
        <div className="mx-auto flex w-full max-w-2xl overflow-hidden rounded-xl border border-gray-200 bg-white focus-within:border-brand-600">
          <div className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-400">
              ⌕
            </span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              placeholder={
                voiceActive ? '🎙 Listening… speak now' : 'Search for products, brands and more...'
              }
              aria-label="Search"
              role="combobox"
              aria-expanded={showDropdown}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
              autoComplete="off"
              enterKeyHint="search"
              className="t-search w-full bg-transparent py-2.5 pl-9 pr-8 outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setSuggestions(null);
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-base leading-none text-gray-400 transition hover:text-ink-900"
              >
                ×
              </button>
            )}
          </div>
          <button
            type="submit"
            className="t-btn shrink-0 bg-ink-900 px-5 text-white transition hover:bg-ink-800"
          >
            Search
          </button>
        </div>
      </form>

      {/* Screen readers get the count; sighted users get the list. */}
      <div className="sr-only" role="status" aria-live="polite">
        {showDropdown
          ? options.length > 0
            ? `${options.length} suggestion${options.length === 1 ? '' : 's'} available`
            : 'No suggestions'
          : ''}
      </div>

      {showDropdown && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Search suggestions"
          // max-h keeps the list above an on-screen keyboard, which covers
          // roughly half a phone viewport.
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain rounded-xl border border-gray-100 bg-white py-1 shadow-2xl"
        >
          {understood && understood.chips.length > 0 && (
            // Not removable here — the results page owns that, and a chip that
            // looked dismissible but only closed the dropdown would be worse
            // than none. This is only so "under 15k" does not vanish without
            // explanation between typing it and seeing phones.
            <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-100 px-3 pb-2 pt-2">
              <span className="text-[11px] text-gray-400">Understood:</span>
              {understood.chips.map((chip) => (
                <span
                  key={chip.key}
                  title={chip.hint}
                  className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700"
                >
                  {chip.label}
                </span>
              ))}
            </div>
          )}

          {options.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-500">
              Nothing matches “{typed}”.
              <br />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => submitRaw(query)}
                className="mt-1 font-semibold text-brand-600 hover:underline"
              >
                Search anyway →
              </button>
            </p>
          ) : (
            rows.map(({ option, index, heading }) => (
              <div key={`${option.kind}-${option.label}-${index}`}>
                {heading && (
                  <div className="flex items-center justify-between px-3 pb-1 pt-2">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
                      {heading}
                    </span>
                    {option.kind === 'recent' && (
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          clearRecentSearches();
                          setRecent([]);
                        }}
                        className="text-[11px] font-semibold text-gray-400 hover:text-ink-900"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
                <div
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-index={index}
                  tabIndex={-1}
                  // onMouseDown, not onClick: the input blurring first would
                  // close the dropdown before the click ever landed.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(option);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${
                    index === activeIndex ? 'bg-cream-100' : ''
                  }`}
                >
                  {option.kind === 'query' && (
                    <>
                      <span className="flex w-10 shrink-0 justify-center text-gray-400">
                        <MagnifierIcon />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {/* The raw input, not the trimmed one: a trailing space is
                            part of what was typed and belongs in the plain half. */}
                        <Completion phrase={option.label} typed={query} />
                      </span>
                    </>
                  )}

                  {(option.kind === 'product' || option.kind === 'trending') && (
                    <>
                      {option.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={option.imageUrl}
                          alt=""
                          loading="lazy"
                          className="h-10 w-10 shrink-0 rounded-md bg-cream-100 object-cover"
                        />
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-md bg-cream-100" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                        <Highlighted text={option.label} match={typed} />
                      </span>
                      <span className="shrink-0 text-sm font-bold text-ink-900">
                        {formatPaise(option.pricePaise)}
                      </span>
                    </>
                  )}

                  {option.kind === 'category' && (
                    <>
                      <span className="w-10 shrink-0 text-center text-gray-400">⊞</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                        <Highlighted text={option.label} match={typed} />
                        {/* Two categories can share a name under different
                            parents, so the parent is what tells them apart. */}
                        {option.parentName && (
                          <span className="text-gray-400"> in {option.parentName}</span>
                        )}
                      </span>
                    </>
                  )}

                  {option.kind === 'brand' && (
                    <>
                      <span className="w-10 shrink-0 text-center text-gray-400">◇</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                        <Highlighted text={option.label} match={typed} />
                      </span>
                    </>
                  )}

                  {option.kind === 'recent' && (
                    <>
                      <span className="w-10 shrink-0 text-center text-gray-400">↻</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                        {option.label}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {voiceSupported && onVoiceSearch && (
        <button
          type="button"
          onClick={onVoiceSearch}
          disabled={voiceActive}
          title="Search by voice (AI)"
          className={`absolute right-[6.5rem] top-1/2 hidden -translate-y-1/2 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-bold transition lg:flex ${
            voiceActive ? 'animate-pulse text-red-500' : 'text-brand-700 hover:bg-brand-50'
          }`}
        >
          🎙
        </button>
      )}
    </div>
  );
}
