'use client';

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
            {label.courierName ?? 'Courier not assigned'}
          </p>
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
        <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Contents</p>
        <p className="text-sm text-ink-900">
          {label.title}{' '}
          <span className="text-gray-500">
            {label.variantLabel ? `·  ` : ''}· Qty {label.quantity}
          </span>
        </p>
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
            No AWB yet — ship this item to book a shipment, then reprint.
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

function LabelsView() {
  const params = useSearchParams();
  const ids = params.get('ids') ?? '';
  const [labels, setLabels] = useState<SellerShippingLabel[] | null>(null);
  const [error, setError] = useState('');

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
            {labels ? `${labels.length} label(s) ready` : 'Loading…'} — print on A4 or a 4×6 roll.
          </p>
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

      {labels?.map((label) => <Label key={label.orderItemId} label={label} />)}
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
