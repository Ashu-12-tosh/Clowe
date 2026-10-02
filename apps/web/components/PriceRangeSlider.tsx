'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PriceFacet } from '@clowe/shared';

interface Props {
  price: PriceFacet;
  /** Rupees; null clears that end. */
  onApply: (min: number | null, max: number | null) => void;
}

/** Slider positions per histogram bar: fine enough to land on any ₹10 in a narrow bar. */
const STEPS_PER_BAR = 20;

/**
 * Two-handle price slider over a histogram, like Amazon's.
 *
 * The API sends the bars; each gets equal width here, and a handle moves
 * through a bar's prices evenly. When the bars are log-spaced (prices from
 * hundreds to lakhs) the slider is therefore log-scaled too, so ₹500 and
 * ₹5,000 are as far apart as ₹50,000 and ₹5 lakh. The filter applies on
 * release, or from the boxes for an exact figure.
 */
export default function PriceRangeSlider({ price, onApply }: Props) {
  const edges = useMemo(() => {
    const e = price.histogram.map((b) => b.fromPaise);
    e.push(price.histogram.at(-1)?.toPaise ?? price.maxPaise);
    return e.length >= 2 ? e : [price.minPaise, price.maxPaise];
  }, [price]);
  const bars = edges.length - 1;
  const max = bars * STEPS_PER_BAR;

  /** Slider position → paise, along the bars. */
  const toPaise = (pos: number) => {
    const bar = Math.min(bars - 1, Math.floor(pos / STEPS_PER_BAR));
    const t = (pos - bar * STEPS_PER_BAR) / STEPS_PER_BAR;
    return Math.round(edges[bar] + t * (edges[bar + 1] - edges[bar]));
  };
  /** Paise → nearest slider position. */
  const toPos = (paise: number) => {
    if (paise <= edges[0]) return 0;
    if (paise >= edges[bars]) return max;
    const bar = edges.findIndex((e, i) => paise >= e && paise < edges[i + 1]);
    const span = edges[bar + 1] - edges[bar] || 1;
    return Math.round((bar + (paise - edges[bar]) / span) * STEPS_PER_BAR);
  };

  const [lo, setLo] = useState(0);
  const [hi, setHi] = useState(max);
  const [typedMin, setTypedMin] = useState('');
  const [typedMax, setTypedMax] = useState('');

  // Re-sync whenever the URL or the result set moves the bounds.
  useEffect(() => {
    setLo(price.selectedMinPaise !== null ? toPos(price.selectedMinPaise) : 0);
    setHi(price.selectedMaxPaise !== null ? toPos(price.selectedMaxPaise) : max);
    setTypedMin(price.selectedMinPaise !== null ? String(Math.round(price.selectedMinPaise / 100)) : '');
    setTypedMax(price.selectedMaxPaise !== null ? String(Math.round(price.selectedMaxPaise / 100)) : '');
    // toPos depends only on edges, which depend on price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, max]);

  if (price.maxPaise <= price.minPaise) return null;

  /** Rounded to what a shopper would type: ₹10, ₹50, ₹500, ₹1,000 steps by size. */
  const rupees = (paise: number) => {
    const r = paise / 100;
    const step = r < 1_000 ? 10 : r < 10_000 ? 50 : r < 100_000 ? 500 : 1_000;
    return Math.round(r / step) * step;
  };
  const fmt = (r: number) => `₹${r.toLocaleString('en-IN')}`;
  // A handle still where the URL put it shows the exact figure chosen, not
  // the nearest slider position.
  const loRupees =
    price.selectedMinPaise !== null && lo === toPos(price.selectedMinPaise)
      ? Math.round(price.selectedMinPaise / 100)
      : rupees(toPaise(lo));
  const hiRupees =
    price.selectedMaxPaise !== null && hi === toPos(price.selectedMaxPaise)
      ? Math.round(price.selectedMaxPaise / 100)
      : rupees(toPaise(hi));

  function apply() {
    onApply(lo > 0 ? loRupees : null, hi < max ? hiRupees : null);
  }
  function applyTyped(e: React.FormEvent) {
    e.preventDefault();
    const min = typedMin ? Math.max(0, Math.round(Number(typedMin))) : null;
    const max_ = typedMax ? Math.max(0, Math.round(Number(typedMax))) : null;
    if (min !== null && max_ !== null && min > max_) onApply(max_, min);
    else onApply(min, max_);
  }

  const peak = Math.max(1, ...price.histogram.map((b) => b.count));
  const pct = (pos: number) => (pos / max) * 100;

  return (
    <div data-price-slider>
      <p className="text-sm font-bold text-ink-900">
        {fmt(loRupees)} – {fmt(hiRupees)}
        {hi >= max ? '+' : ''}
      </p>

      {/* How many products sit at each price — the bars inside the range in colour. */}
      <div className="mt-3 flex h-10 items-end gap-px" aria-hidden="true">
        {price.histogram.map((bar, i) => {
          const inside = (i + 1) * STEPS_PER_BAR > lo && i * STEPS_PER_BAR < hi;
          return (
            <div
              key={bar.fromPaise}
              title={`${fmt(Math.round(bar.fromPaise / 100))}–${fmt(Math.round(bar.toPaise / 100))}: ${bar.count}`}
              className={`flex-1 rounded-t-sm ${inside ? 'bg-brand-500' : 'bg-gray-200'}`}
              style={{ height: `${bar.count ? Math.max(8, (bar.count / peak) * 100) : 0}%` }}
            />
          );
        })}
      </div>

      <div className="dual-range relative h-5">
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-gray-200" />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-brand-600"
          style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }}
        />
        <input
          type="range"
          min={0}
          max={max}
          value={lo}
          aria-label="Minimum price"
          aria-valuetext={fmt(loRupees)}
          onChange={(e) => setLo(Math.min(Number(e.target.value), hi - 1))}
          onMouseUp={() => apply()}
          onTouchEnd={() => apply()}
          onKeyUp={() => apply()}
        />
        <input
          type="range"
          min={0}
          max={max}
          value={hi}
          aria-label="Maximum price"
          aria-valuetext={fmt(hiRupees)}
          onChange={(e) => setHi(Math.max(Number(e.target.value), lo + 1))}
          onMouseUp={() => apply()}
          onTouchEnd={() => apply()}
          onKeyUp={() => apply()}
        />
      </div>

      <form onSubmit={applyTyped} className="mt-3 flex items-center gap-1.5">
        <input
          inputMode="numeric"
          value={typedMin}
          onChange={(e) => setTypedMin(e.target.value.replace(/\D/g, ''))}
          placeholder={`₹${rupees(price.minPaise).toLocaleString('en-IN')}`}
          aria-label="Minimum price in rupees"
          className="w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs outline-none focus:border-brand-600"
        />
        <span className="text-xs text-gray-400">to</span>
        <input
          inputMode="numeric"
          value={typedMax}
          onChange={(e) => setTypedMax(e.target.value.replace(/\D/g, ''))}
          placeholder={`₹${rupees(price.maxPaise).toLocaleString('en-IN')}`}
          aria-label="Maximum price in rupees"
          className="w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs outline-none focus:border-brand-600"
        />
        <button type="submit" className="rounded-md border border-gray-300 px-2 py-1 text-xs font-semibold hover:border-brand-600">
          Go
        </button>
      </form>
    </div>
  );
}
