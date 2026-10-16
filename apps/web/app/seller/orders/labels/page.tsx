'use client';

import { setFunctional } from '@/lib/cookieConsent';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { SellerShippingLabel } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

/** Barcode-ish strip drawn from the AWB so labels scan as "real" documents. */
function BarcodeStrip({ value }: { value: string }) {
  const bars = Array.from(value).flatMap((char, i) => {
    const code = char.charCodeAt(0) + i;
    return [1 + (code % 3), 1 + ((code >> 2) % 2)];
  });
  return (
    <div className="flex h-10 items-end gap-[2px]">
      {bars.map((w, i) => (
        <span
          key={i}
          className={i % 2 === 0 ? 'bg-ink-900' : 'bg-transparent'}
          style={{ width: `${w}px`, height: '100%' }}
        />
      ))}
    </div>
  );
}

function Label({ label }: { label: SellerShippingLabel }) {
  const { shipTo, shipFrom } = label;
  return (
    <article className="print-sheet mb-4 break-inside-avoid rounded-xl border-2 border-ink-900 bg-white p-4">
      <header className="flex items-start justify-between border-b-2 border-dashed border-gray-300 pb-2">
        <div>
          <p className="font-display text-lg font-bold uppercase tracking-[0.2em] text-ink-900">
            Clowe
          </p>
          <p className="text-[11px] text-gray-500">Order {label.orderNumber}</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-bold uppercase tracking-wide">
            {label.courierName ?? 'Not booked yet'}
            {label.mode && ` · ${label.mode === 'EXPRESS' ? 'Express' : 'Surface'}`}
          </p>
          {label.sortCode && <p className="font-mono text-base font-bold text-ink-900">{label.sortCode}</p>}
          {label.destinationHub && <p className="text-[10px] text-gray-500">{label.destinationHub}</p>}
          {label.isCod ? (
            <p className="mt-0.5 inline-block rounded bg-ink-900 px-2 py-0.5 text-xs font-bold text-white">
              COD {formatPaise(label.codAmountPaise)}
            </p>
          ) : (
            <p className="mt-0.5 text-xs font-semibold text-green-700">PREPAID — do not collect</p>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-4 py-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Deliver to</p>
          <p className="mt-1 text-sm font-bold text-ink-900">{shipTo.name}</p>
          <p className="text-xs leading-relaxed text-gray-700">
            {shipTo.line1}
            {shipTo.line2 && <>, {shipTo.line2}</>}
            <br />
            {shipTo.city}, {shipTo.state} — <span className="font-bold">{shipTo.pincode}</span>
          </p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
            Return / ship from
          </p>
          <p className="mt-1 text-sm font-semibold text-ink-900">{shipFrom.shopName}</p>
          <p className="text-xs leading-relaxed text-gray-700">
            {shipFrom.line1 ?? '—'}
            <br />
            {[shipFrom.city, shipFrom.state, shipFrom.pincode].filter(Boolean).join(', ')}
            {shipFrom.gstNumber && (
              <>
                <br />
                GSTIN: {shipFrom.gstNumber}
              </>
            )}
          </p>
        </div>
      </div>

      <div className="border-t-2 border-dashed border-gray-300 py-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
          Contents{label.weightGrams ? ` · ${label.weightGrams / 1000} kg` : ''}
        </p>
        {label.contents.map((c, i) => (
          <p key={i} className="text-sm text-ink-900">
            {c.title}{' '}
            <span className="text-gray-500">
              {c.variantLabel ? `· ${c.variantLabel} ` : ''}· Qty {c.quantity}
            </span>
          </p>
        ))}
      </div>

      <footer className="flex items-end justify-between gap-4 border-t-2 border-dashed border-gray-300 pt-2">
        <div className="min-w-0 flex-1">
        {label.awbNumber ? (
          <>
            <BarcodeStrip value={label.awbNumber} />
            <p className="mt-1 font-mono text-sm font-bold tracking-wider text-ink-900">
              AWB {label.awbNumber}
            </p>
          </>
        ) : (
          <p className="text-xs font-semibold text-red-600">
            No AWB yet — book it with Delhivery, then reprint.
          </p>
        )}
        </div>
        <div className="shrink-0 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={label.qr.dataUrl}
            alt="QR code - open this order in the seller panel"
            className="h-24 w-24"
          />
          <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500">
            Scan for order details
          </p>
        </div>
      </footer>
    </article>
  );
}

type LabelSize = 'THERMAL_4X6' | 'A4_4UP';
const SIZE_KEY = 'clowe.labelSize';

/** The page the printer gets: one 4×6 label per page, or four to an A4 sheet. */
const PAGE_CSS: Record<LabelSize, string> = {
  THERMAL_4X6: '@media print { @page { size: 4in 6in; margin: 0.1in; } .label-grid { display: block; } .label-grid .print-sheet { break-after: page; margin: 0; } }',
  A4_4UP:
    '@media print { @page { size: A4; margin: 8mm; } .label-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; } .label-grid .print-sheet { margin: 0; font-size: 0.85em; } .label-grid .print-sheet:nth-child(4n) { break-after: page; } }',
};

function LabelsView() {
  const params = useSearchParams();
  const ids = params.get('ids') ?? '';
  const [labels, setLabels] = useState<SellerShippingLabel[] | null>(null);
  const [error, setError] = useState('');
  const [size, setSize] = useState<LabelSize>('THERMAL_4X6');

  // The seller's printer doesn't change between visits: remember the choice.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SIZE_KEY);
      if (saved === 'THERMAL_4X6' || saved === 'A4_4UP') setSize(saved);
    } catch {
      // Storage unavailable: start from 4×6.
    }
  }, []);
  function pick(next: LabelSize) {
    setSize(next);
    try {
      setFunctional(SIZE_KEY, next);
    } catch {
      // Not remembered; still used for this print.
    }
  }

  useEffect(() => {
    if (!ids) {
      setError('No items selected.');
      return;
    }
    api<SellerShippingLabel[]>(`/api/seller/orders/labels?ids=${encodeURIComponent(ids)}`, {
      auth: true,
    })
      .then(setLabels)
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load labels'),
      );
  }, [ids]);

  return (
    <div className="mx-auto max-w-3xl">
      <div data-print-hide className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-xl font-bold text-ink-900">Shipping labels</h1>
          <p className="text-xs text-gray-500">
            {labels ? `${labels.length} label(s) ready` : 'Loading…'} — one per parcel.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 p-0.5 text-xs" role="radiogroup" aria-label="Label size">
          {(
            [
              ['THERMAL_4X6', '4×6 thermal'],
              ['A4_4UP', 'A4 · 4 per sheet'],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={size === value}
              onClick={() => pick(value)}
              className={`rounded-md px-2.5 py-1 font-semibold ${size === value ? 'bg-ink-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {text}
            </button>
          ))}
        </div>
        <button
          onClick={() => window.print()}
          disabled={!labels || labels.length === 0}
          className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          🖨 Print
        </button>
      </div>

      {error && (
        <p data-print-hide className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <style>{PAGE_CSS[size]}</style>
      <div className="label-grid" data-label-size={size}>
        {labels?.map((label) => <Label key={label.key} label={label} />)}
      </div>
      {labels && labels.length === 0 && (
        <p className="text-sm text-gray-500">Nothing to print for this selection.</p>
      )}
    </div>
  );
}

/** useSearchParams needs a boundary for the client-side bailout. */
export default function SellerLabelsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
      <LabelsView />
    </Suspense>
  );
}
