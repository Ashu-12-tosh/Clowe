'use client';

import { useEffect } from 'react';

/**
 * The filter rail on a phone or tablet: a bottom sheet over the results.
 * Filters apply as they are picked (the results update behind it); the
 * buttons clear everything or close it on the new count.
 */
export default function FilterSheet({
  open,
  onClose,
  onClearAll,
  applied,
  total,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onClearAll: () => void;
  applied: number;
  total: number | null;
  children: React.ReactNode;
}) {
  // The page behind must not scroll while the sheet is up; Escape closes it.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden" onClick={onClose} data-filter-sheet>
      <div className="absolute inset-0 bg-black/50" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filters"
        className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-gray-300" aria-hidden="true" />
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h2 className="text-base font-bold">
            Filters
            {applied > 0 && (
              <span className="ml-2 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-700">{applied} applied</span>
            )}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close filters" className="rounded-full p-1.5 text-xl text-gray-400 hover:bg-gray-100">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
        <div className="flex gap-3 border-t border-gray-100 px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClearAll}
            className="flex-1 rounded-xl border border-gray-300 py-3 text-sm font-bold uppercase tracking-wide text-ink-900"
          >
            Clear all
          </button>
          <button type="button" onClick={onClose} className="flex-1 rounded-xl bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white">
            Show {total === null ? '' : `${total.toLocaleString('en-IN')} `}results
          </button>
        </div>
      </div>
    </div>
  );
}
