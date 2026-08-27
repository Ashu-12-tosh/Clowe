'use client';

import { useState } from 'react';

interface Props {
  label: string;
  /** Suggested values; the shopper can also type their own. */
  options: readonly string[];
  value: string[];
  max?: number;
  placeholder?: string;
  onChange: (next: string[]) => void;
}

/** Removable chips plus an "add" picker — used by the About You fields. */
export default function ChipPicker({
  label,
  options,
  value,
  max = 8,
  placeholder = 'Add…',
  onChange,
}: Props) {
  const [draft, setDraft] = useState('');
  const remaining = options.filter((o) => !value.includes(o));
  const full = value.length >= max;

  function add(raw: string) {
    const item = raw.trim();
    if (!item || value.includes(item) || full) return;
    onChange([...value, item]);
    setDraft('');
  }

  return (
    <div>
      <label className="t-card-label block text-gray-600">{label}</label>
      <div className="mt-1.5 flex min-h-[2.75rem] flex-wrap items-center gap-1.5 rounded-lg border border-gray-300 px-2 py-1.5 focus-within:border-brand-600">
        {value.map((item) => (
          <span
            key={item}
            className="flex items-center gap-1 rounded-md bg-cream-100 px-2 py-1 text-xs font-semibold text-ink-900"
          >
            {item}
            <button
              type="button"
              onClick={() => onChange(value.filter((v) => v !== item))}
              aria-label={`Remove ${item}`}
              className="text-gray-400 hover:text-red-600"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
          onBlur={() => add(draft)}
          disabled={full}
          placeholder={full ? `Up to ${max}` : placeholder}
          aria-label={label}
          className="min-w-24 flex-1 bg-transparent px-1 py-1 text-sm outline-none disabled:cursor-not-allowed"
        />
      </div>

      {remaining.length > 0 && !full && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {remaining.slice(0, 6).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => add(option)}
              className="rounded-md border border-dashed border-gray-300 px-2 py-0.5 text-xs text-gray-500 transition hover:border-brand-600 hover:text-brand-600"
            >
              + {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
