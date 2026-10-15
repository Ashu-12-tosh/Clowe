'use client';

import { useSyncExternalStore } from 'react';
import { getToasts, subscribeToasts, toast, type ToastItem } from '@/lib/toast';

const NONE: ToastItem[] = [];

const STYLE: Record<ToastItem['kind'], { box: string; icon: string }> = {
  success: { box: 'border-green-200 bg-green-50 text-green-900', icon: '✓' },
  error: { box: 'border-red-200 bg-red-50 text-red-800', icon: '!' },
  info: { box: 'border-gray-200 bg-white text-gray-800', icon: 'i' },
};

/** The messages themselves: errors are alerts (read out at once), the rest polite. */
export function ToastList({ items, onDismiss }: { items: ToastItem[]; onDismiss?: (id: number) => void }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 top-4 z-[1000] flex flex-col items-center gap-2 sm:left-auto sm:right-4 sm:items-end"
      data-toaster
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-toast={t.kind}
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg ${STYLE[t.kind].box}`}
        >
          <span aria-hidden className="mt-px font-bold">
            {STYLE[t.kind].icon}
          </span>
          <span className="flex-1 break-words">{t.message}</span>
          {onDismiss && (
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss"
              className="-mr-1 px-1 text-base leading-none opacity-60 hover:opacity-100"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Mounted once, in the root layout. */
export default function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, () => NONE);
  return <ToastList items={items} onDismiss={toast.dismiss} />;
}
