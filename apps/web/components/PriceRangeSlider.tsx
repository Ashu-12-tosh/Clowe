'use client';

import { useEffect, useState } from 'react';

interface Props {
  /** Bounds in rupees. */
  min: number;
  max: number;
  /** Currently applied values (rupees); null = not filtered. */
  valueMin: number | null;
  valueMax: number | null;
  onApply: (min: number | null, max: number | null) => void;
}

/**
 * Amazon-style dual-thumb price slider. Drag either handle; the filter is
 * applied when you release it.
 */
export default function PriceRangeSlider({ min, max, valueMin, valueMax, onApply }: Props) {
  const [lo, setLo] = useState(valueMin ?? min);
  const [hi, setHi] = useState(valueMax ?? max);

  // Re-sync when the URL filters or the category bounds change.
  useEffect(() => {
    setLo(Math.max(min, valueMin ?? min));
    setHi(Math.min(max, valueMax ?? max));
  }, [min, max, valueMin, valueMax]);

  if (max <= min) return null;

  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  function apply() {
    onApply(lo > min ? lo : null, hi < max ? hi : null);
  }

  const fmt = (v: number) => `₹${v.toLocaleString('en-IN')}`;

  return (
    <div>
      <p className="text-sm font-bold">
        {fmt(lo)} – {fmt(hi)}
        {hi >= max ? '+' : ''}
      </p>
      <div className="dual-range relative mt-3 h-5">
        {/* Track */}
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-gray-200" />
        {/* Selected range */}
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-brand-600"
          style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          value={lo}
          aria-label="Minimum price"
          onChange={(e) => setLo(Math.min(Number(e.target.value), hi - 1))}
          onMouseUp={apply}
          onTouchEnd={apply}
          onKeyUp={apply}
        />
        <input
          type="range"
          min={min}
          max={max}
          value={hi}
          aria-label="Maximum price"
          onChange={(e) => setHi(Math.max(Number(e.target.value), lo + 1))}
          onMouseUp={apply}
          onTouchEnd={apply}
          onKeyUp={apply}
        />
      </div>
    </div>
  );
}
