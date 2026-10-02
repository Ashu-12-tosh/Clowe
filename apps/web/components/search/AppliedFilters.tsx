'use client';

import type { AppliedFilter } from '@clowe/shared';

/** The filters applied, each removable, and a way to drop them all. */
export default function AppliedFilters({
  applied,
  onRemove,
  onClearAll,
}: {
  applied: AppliedFilter[];
  onRemove: (chip: AppliedFilter) => void;
  onClearAll: () => void;
}) {
  if (applied.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-applied-filters>
      {applied.map((chip) => (
        <button
          key={`${chip.param}=${chip.value}`}
          type="button"
          onClick={() => onRemove(chip)}
          aria-label={`Remove filter ${chip.label}`}
          className="flex max-w-full items-center gap-1.5 rounded-full border border-brand-600 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-100"
        >
          <span className="truncate">{chip.label}</span>
          <span aria-hidden="true">✕</span>
        </button>
      ))}
      <button type="button" onClick={onClearAll} className="px-1 text-xs font-semibold text-gray-600 underline hover:text-brand-600">
        Clear all
      </button>
    </div>
  );
}
