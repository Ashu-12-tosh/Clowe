'use client';

import { useState } from 'react';
import type { TrackingScanView } from '@clowe/shared';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * The courier's scans for a parcel, newest first: the latest always shown,
 * the rest on "Show all". Nothing at all until the courier has scanned it.
 */
export function ScanTimeline({ scans }: { scans: TrackingScanView[] | undefined }) {
  const [open, setOpen] = useState(false);
  if (!scans || scans.length === 0) return null;
  const shown = open ? scans : scans.slice(0, 1);
  return (
    <div className="mt-1.5 text-xs" data-scans={scans.length}>
      <ol className="space-y-1 border-l-2 border-brand-200 pl-3">
        {shown.map((s, i) => (
          <li key={`${s.at}-${i}`} className={i === 0 ? 'text-ink-900' : 'text-gray-500'}>
            <span className="font-semibold">{s.status}</span>
            {s.location && <span> · {s.location}</span>}
            <span className="block text-[11px] text-gray-400">{when(s.at)}</span>
          </li>
        ))}
      </ol>
      {scans.length > 1 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-[11px] font-semibold text-brand-600 hover:underline"
        >
          {open ? 'Show less' : `Show all ${scans.length} updates`}
        </button>
      )}
    </div>
  );
}
