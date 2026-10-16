'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { COMPARE_MAX } from '@clowe/shared';
import { clearCompare, toggleCompare, useCompare } from '@/lib/compare';
import { toast } from '@/lib/toast';

/** "Compare" on a product: adds it to (or takes it off) the compare list. */
export function CompareButton({ productId, className = '' }: { productId: string; className?: string }) {
  const ids = useCompare();
  const on = ids.includes(productId);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!toggleCompare(productId)) toast.error(`You can compare up to ${COMPARE_MAX} products — remove one first`);
      }}
      aria-pressed={on}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${on ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-gray-300 text-gray-700 hover:border-brand-600'} ${className}`}
      data-compare-toggle={productId}
    >
      {on ? '✓ Comparing' : '⇄ Compare'}
    </button>
  );
}

/** Bottom bar while two or more products are picked; hidden on the compare page itself. */
export default function CompareBar() {
  const ids = useCompare();
  const path = usePathname();
  if (ids.length < 1 || path?.startsWith('/compare') || path?.startsWith('/admin') || path?.startsWith('/seller')) return null;
  return (
    <div className="fixed inset-x-0 bottom-3 z-40 flex justify-center px-4" data-compare-bar>
      <div className="flex items-center gap-3 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm shadow-lg">
        <span className="font-semibold text-ink-900">
          {ids.length} of {COMPARE_MAX} to compare
        </span>
        <Link href={`/compare?ids=${ids.join(',')}`} className={`rounded-full px-4 py-1.5 text-xs font-bold text-white ${ids.length >= 2 ? 'bg-ink-900' : 'pointer-events-none bg-gray-300'}`}>
          Compare
        </Link>
        <button type="button" onClick={clearCompare} className="text-xs text-gray-500 hover:underline">
          Clear
        </button>
      </div>
    </div>
  );
}
