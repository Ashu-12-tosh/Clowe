'use client';

import { useEffect, useState } from 'react';
import type { VariantAxis } from '@clowe/shared';

/** One sellable combination, as the product form keeps it. */
export interface GridRow {
  id?: string;
  options: Record<string, string>;
  sku: string;
  price: string;
  mrp: string;
  stock: string;
  imageUrls: string[];
  imagesDirty?: boolean;
}

const cell =
  'w-full rounded-md border border-gray-300 px-2 py-1 text-sm outline-none focus:border-brand-600';

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL'];

/** Sizes in the order people read them: the category's list, then XS→XXL, then numbers, then the rest as added. */
function sizeSorter(known: readonly string[] | undefined) {
  const rank = (v: string) => {
    const k = (known ?? []).findIndex((x) => x.toLowerCase() === v.toLowerCase());
    if (k !== -1) return k;
    const letter = SIZE_ORDER.indexOf(v.toUpperCase());
    if (letter !== -1) return 1000 + letter;
    const n = parseFloat(v);
    return Number.isFinite(n) ? 2000 + n : Number.POSITIVE_INFINITY;
  };
  return (list: string[]) =>
    list
      .map((v, i) => ({ v, i, r: rank(v) }))
      .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
      .map((x) => x.v);
}

/** Distinct, trimmed, non-empty values of one option across the rows, in first-seen order. */
function valuesOf(rows: GridRow[], key: string): string[] {
  const seen: string[] = [];
  for (const r of rows) {
    const v = (r.options[key] ?? '').trim();
    if (v && !seen.some((s) => s.toLowerCase() === v.toLowerCase())) seen.push(v);
  }
  return seen;
}

/**
 * Clothing's colour × size grid. The seller lists colours, then sizes; every
 * pair is a variant with its own stock, all at one price unless a cell is
 * given its own. Removing a colour or size (or one cell) removes those
 * variants; on save, one that was already ordered is retired, not deleted.
 * Pictures are per colour — a colour without its own shows the product photos.
 */
export default function VariantGrid({
  colourAxis,
  sizeAxis,
  rows,
  setRows,
  maxVariants,
  renderColourImages,
}: {
  colourAxis: VariantAxis;
  sizeAxis: VariantAxis;
  rows: GridRow[];
  setRows: (update: (prev: GridRow[]) => GridRow[]) => void;
  maxVariants: number;
  /** The image picker opener for one colour (the form owns the picker). */
  renderColourImages: (colour: string) => React.ReactNode;
}) {
  const C = colourAxis.key;
  const S = sizeAxis.key;
  // Values chosen before any pair exists (a colour with no size yet) have no
  // row to live in, so the lists are kept here and seeded from the rows.
  const [colours, setColours] = useState<string[]>(() => valuesOf(rows, C));
  const [sizes, setSizes] = useState<string[]>(() => valuesOf(rows, S));
  const [colourText, setColourText] = useState('');
  const [sizeText, setSizeText] = useState('');
  const firstPriced = rows.find((r) => r.price.trim());
  const [allPrice, setAllPrice] = useState(firstPriced?.price ?? '');
  const [allMrp, setAllMrp] = useState(firstPriced?.mrp ?? '');

  // A blank starter row has no place in the grid: drop it. A saved variant
  // without a colour or size (a listing that used to be one version) is kept
  // and listed below the grid, for the seller to remove.
  const complete = (r: GridRow) => !!(r.options[C] ?? '').trim() && !!(r.options[S] ?? '').trim();
  useEffect(() => {
    setRows((prev) => (prev.some((r) => !r.id && !complete(r)) ? prev.filter((r) => r.id || complete(r)) : prev));
    // Once, when the grid opens; a new pair of options remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const outside = rows.filter((r) => !complete(r));

  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const indexOf = (list: GridRow[], colour: string, size: string) =>
    list.findIndex((r) => same(r.options[C] ?? '', colour) && same(r.options[S] ?? '', size));

  /** A new cell: the common price, and the colour's pictures if it has some. */
  function newRow(list: GridRow[], colour: string, size: string): GridRow {
    const sibling = list.find((r) => same(r.options[C] ?? '', colour) && r.imageUrls.length > 0);
    return {
      options: { [C]: colour, [S]: size },
      sku: '',
      price: allPrice,
      mrp: allMrp,
      stock: '10',
      imageUrls: sibling ? [...sibling.imageUrls] : [],
      imagesDirty: !!sibling,
    };
  }

  function addValue(kind: 'colour' | 'size', raw: string) {
    const value = raw.trim().slice(0, 60);
    if (!value) return;
    const list = kind === 'colour' ? colours : sizes;
    if (list.some((v) => same(v, value))) return;
    if (kind === 'colour') {
      setColours([...colours, value]);
      setColourText('');
      setRows((prev) => [...prev, ...sizes.filter((s) => indexOf(prev, value, s) === -1).map((s) => newRow(prev, value, s))]);
    } else {
      setSizes([...sizes, value]);
      setSizeText('');
      setRows((prev) => [...prev, ...colours.filter((c) => indexOf(prev, c, value) === -1).map((c) => newRow(prev, c, value))]);
    }
  }

  function removeValue(kind: 'colour' | 'size', value: string) {
    const key = kind === 'colour' ? C : S;
    if (kind === 'colour') setColours(colours.filter((v) => !same(v, value)));
    else setSizes(sizes.filter((v) => !same(v, value)));
    setRows((prev) => prev.filter((r) => !same(r.options[key] ?? '', value)));
  }

  function setCell(colour: string, size: string, patch: Partial<GridRow>) {
    setRows((prev) => prev.map((r, i) => (i === indexOf(prev, colour, size) ? { ...r, ...patch } : r)));
  }

  function applyToAll() {
    setRows((prev) => prev.map((r) => (complete(r) ? { ...r, price: allPrice, mrp: allMrp } : r)));
  }

  const total = colours.length * sizes.length;
  const shownSizes = sizeSorter(sizeAxis.values)(sizes);

  function chipInput(kind: 'colour' | 'size') {
    const axis = kind === 'colour' ? colourAxis : sizeAxis;
    const list = kind === 'colour' ? colours : sizes;
    const text = kind === 'colour' ? colourText : sizeText;
    const setText = kind === 'colour' ? setColourText : setSizeText;
    const suggestions = (axis.values ?? []).filter((v) => !list.some((x) => same(x, v)));
    return (
      <div>
        <p className="text-xs font-semibold text-gray-600">
          {kind === 'colour' ? '1. Colours' : '2. Sizes'}{' '}
          <span className="font-normal text-gray-400">({list.length})</span>
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {(kind === 'size' ? sizeSorter(sizeAxis.values)(list) : list).map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1.5 rounded-full bg-ink-900 px-2.5 py-1 text-[11px] font-semibold text-white"
            >
              {v}
              <button
                type="button"
                onClick={() => removeValue(kind, v)}
                aria-label={`Remove ${axis.label.toLowerCase()} ${v}`}
                className="text-white/70 hover:text-white"
              >
                ✕
              </button>
            </span>
          ))}
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addValue(kind, text);
              }
            }}
            list={`grid-${kind}-values`}
            placeholder={kind === 'colour' ? 'Add a colour, e.g. Black' : 'Add a size, e.g. M'}
            maxLength={60}
            className="w-40 rounded-full border border-gray-300 bg-white px-3 py-1 text-[11px] outline-none focus:border-brand-600"
          />
          <button
            type="button"
            onClick={() => addValue(kind, text)}
            disabled={!text.trim()}
            className="rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40"
          >
            Add
          </button>
          <datalist id={`grid-${kind}-values`}>
            {suggestions.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        {suggestions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {suggestions.slice(0, 12).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => addValue(kind, v)}
                className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-600 hover:border-ink-900"
              >
                ＋ {v}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-4">
      <div className="grid gap-4 rounded-xl bg-cream-50 p-3 sm:grid-cols-2">
        {chipInput('colour')}
        {chipInput('size')}
      </div>

      {total > 0 && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-100 p-3">
          <label className="text-xs font-semibold text-gray-600">
            Price before GST (₹) *
            <input
              type="number"
              min={1}
              value={allPrice}
              onChange={(e) => setAllPrice(e.target.value)}
              placeholder="499"
              className={`mt-1 block w-28 ${cell}`}
            />
          </label>
          <label className="text-xs font-semibold text-gray-600">
            MRP before GST (₹)
            <input
              type="number"
              min={1}
              value={allMrp}
              onChange={(e) => setAllMrp(e.target.value)}
              placeholder="799"
              className={`mt-1 block w-28 ${cell}`}
            />
          </label>
          <button
            type="button"
            onClick={applyToAll}
            disabled={!allPrice.trim()}
            className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
          >
            Apply to all {rows.length - outside.length} variants
          </button>
          <p className="w-full text-[11px] text-gray-500">
            One price for every colour and size. A cell can have its own: edit its price below.
          </p>
        </div>
      )}

      {total > maxVariants && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {total} combinations — a listing can have at most {maxVariants}. Remove a colour or size, or split it
          into two listings.
        </p>
      )}

      {colours.length > 0 && sizes.length === 0 && (
        <p className="text-xs text-gray-500">Now add the sizes it comes in — the grid appears once both are set.</p>
      )}
      {sizes.length > 0 && colours.length === 0 && (
        <p className="text-xs text-gray-500">Now add the colours — the grid appears once both are set.</p>
      )}

      {outside.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-semibold">Not in the grid</p>
          <p className="mt-0.5">
            {outside.length === 1 ? 'This variant has' : 'These variants have'} no colour or size, so{' '}
            {outside.length === 1 ? 'it' : 'they'} can&apos;t be saved alongside the grid. Remove{' '}
            {outside.length === 1 ? 'it' : 'them'} once the grid is set up.
          </p>
          <ul className="mt-1.5 space-y-1">
            {outside.map((r) => (
              <li key={r.id ?? r.sku} className="flex items-center gap-2">
                <span>
                  {Object.values(r.options).filter(Boolean).join(' · ') || 'One version'}
                  {r.sku ? ` (${r.sku})` : ''} — ₹{r.price || '—'}, stock {r.stock || 0}
                </span>
                <button
                  type="button"
                  onClick={() => setRows((prev) => prev.filter((x) => x !== r))}
                  className="font-semibold text-red-600 hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {total > 0 && (
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500">
                <th className="sticky left-0 z-10 bg-white pb-2 pr-3">Colour</th>
                <th className="pb-2 pr-3">Pictures</th>
                {shownSizes.map((s) => (
                  <th key={s} className="min-w-[96px] pb-2 pr-2 text-center">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {colours.map((c) => (
                <tr key={c} className="border-t border-gray-100 align-top">
                  <th scope="row" className="sticky left-0 z-10 bg-white py-2 pr-3 text-left font-semibold text-ink-900">
                    {c}
                  </th>
                  <td className="py-2 pr-3">{renderColourImages(c)}</td>
                  {shownSizes.map((s) => {
                    const i = indexOf(rows, c, s);
                    const row = i === -1 ? null : rows[i]!;
                    if (!row) {
                      return (
                        <td key={s} className="py-2 pr-2 text-center">
                          <button
                            type="button"
                            onClick={() => setRows((prev) => (indexOf(prev, c, s) === -1 ? [...prev, newRow(prev, c, s)] : prev))}
                            className="rounded-md border border-dashed border-gray-300 px-2 py-1 text-[11px] text-gray-400 hover:border-brand-600 hover:text-brand-600"
                            aria-label={`Add ${c} / ${s}`}
                          >
                            ＋ Add
                          </button>
                        </td>
                      );
                    }
                    const ownPrice = !!allPrice.trim() && row.price !== allPrice;
                    return (
                      <td key={s} className="py-2 pr-2">
                        <div className="relative rounded-lg border border-gray-200 p-1.5">
                          <button
                            type="button"
                            onClick={() => setRows((prev) => prev.filter((_, j) => j !== indexOf(prev, c, s)))}
                            aria-label={`Remove ${c} / ${s}`}
                            title="This combination isn't made"
                            className="absolute -right-1.5 -top-1.5 h-4 w-4 rounded-full bg-gray-200 text-[10px] leading-none text-gray-600 hover:bg-red-500 hover:text-white"
                          >
                            ✕
                          </button>
                          <label className="block text-[10px] text-gray-500">
                            Stock
                            <input
                              type="number"
                              min={0}
                              value={row.stock}
                              onChange={(e) => setCell(c, s, { stock: e.target.value })}
                              aria-label={`Stock for ${c} / ${s}`}
                              className={cell}
                            />
                          </label>
                          <label className={`mt-1 block text-[10px] ${ownPrice ? 'font-semibold text-brand-600' : 'text-gray-500'}`}>
                            {ownPrice ? 'Own price ₹' : 'Price ₹'}
                            <input
                              type="number"
                              min={1}
                              value={row.price}
                              onChange={(e) => setCell(c, s, { price: e.target.value })}
                              aria-label={`Price before GST for ${c} / ${s}`}
                              className={cell}
                            />
                          </label>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
