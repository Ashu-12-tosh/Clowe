'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ADMIN_SHIPMENT_FILTERS,
  ADMIN_SHIPMENT_FILTER_LABELS,
  type AdminShipmentFilter,
  type AdminShipmentPage,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { toast } from '@/lib/toast';
import Spinner from '@/components/Spinner';
import { formatPaise } from '@/lib/format';

const STATUS_TONE: Record<string, string> = {
  DELIVERY_FAILED: 'bg-red-100 text-red-700',
  LOST: 'bg-red-100 text-red-700',
  RTO_IN_TRANSIT: 'bg-orange-100 text-orange-700',
  RTO_DELIVERED: 'bg-orange-100 text-orange-700',
  DELIVERED: 'bg-green-100 text-green-700',
  IN_TRANSIT: 'bg-blue-100 text-blue-700',
  OUT_FOR_DELIVERY: 'bg-blue-100 text-blue-700',
};

/**
 * Every parcel with Delhivery, for operations: what needs someone first
 * (failed attempts, lost parcels, parcels coming back or back and unchecked,
 * bookings not collected in two days), then everything by status. Refresh
 * asks Delhivery now; "Try again" re-attempts a failed delivery.
 */
export default function AdminShipmentsPage() {
  const [filter, setFilter] = useState<AdminShipmentFilter>('ATTENTION');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminShipmentPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    const params = new URLSearchParams({ filter, page: String(page) });
    if (q.trim()) params.set('q', q.trim());
    api<AdminShipmentPage>(`/api/admin/shipments?${params}`, { auth: true })
      .then(setData)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load parcels'));
  }, [filter, page, q]);
  useEffect(load, [load]);

  async function run(id: string, path: string, body: unknown, done: string) {
    if (busy) return;
    setBusy(`${id}:${path}`);
    setError('');
    try {
      await api(`/api/admin/orders/shipments/${id}/${path}`, { method: 'POST', body, auth: true, success: done });
      setNotice(done);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'That did not go through');
    } finally {
      setBusy(null);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4 pb-10">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Parcels</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Every parcel with Delhivery
          {data && (
            <>
              {' '}— courier: <span className="font-semibold">{data.provider === 'mock' ? 'test courier (mock)' : `Delhivery ${data.environment}`}</span>
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {ADMIN_SHIPMENT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => {
              setFilter(f);
              setPage(1);
            }}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === f ? 'bg-ink-900 text-white' : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50'}`}
          >
            {ADMIN_SHIPMENT_FILTER_LABELS[f]}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="AWB, order or shop"
          className="ml-auto w-48 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs outline-none focus:border-brand-600"
        />
      </div>

      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-xs font-medium text-green-800">{notice}</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="bg-cream-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 font-semibold">AWB</th>
              <th className="px-3 py-2 font-semibold">Order</th>
              <th className="px-3 py-2 font-semibold">Seller</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Last scan</th>
              <th className="px-3 py-2 font-semibold">COD</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {data?.rows.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 font-mono">
                  {s.awbNumber ?? '—'}
                  {s.kind === 'REVERSE' && <span className="ml-1 rounded bg-gray-100 px-1 font-sans text-[10px] text-gray-500">return</span>}
                </td>
                <td className="px-3 py-2">{s.orderNumber}</td>
                <td className="px-3 py-2">{s.shopName}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE[s.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {s.status.replace(/_/g, ' ').toLowerCase()}
                  </span>
                  {s.statusText && <span className="block text-[11px] text-gray-500">{s.statusText}</span>}
                </td>
                <td className="px-3 py-2 text-gray-500">{s.lastScanAt ? new Date(s.lastScanAt).toLocaleString('en-IN') : '—'}</td>
                <td className="px-3 py-2">{s.paymentType === 'COD' ? formatPaise(s.codAmountPaise) : '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {s.awbNumber && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void run(s.id, 'refresh', undefined, `Asked Delhivery about ${s.awbNumber}.`)}
                      aria-busy={busy === `${s.id}:refresh`}
                      className="rounded-lg border border-gray-300 px-2 py-0.5 text-[11px] font-semibold hover:bg-gray-50 disabled:opacity-50"
                    >
                      {busy === `${s.id}:refresh` && <Spinner className="mr-1" />}
                      Refresh
                    </button>
                  )}
                  {s.status === 'DELIVERY_FAILED' && !s.ndrAction && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void run(s.id, 'ndr', { action: 'RE_ATTEMPT' }, `Asked Delhivery to try ${s.awbNumber} again.`)}
                      aria-busy={busy === `${s.id}:ndr`}
                      className="ml-1 rounded-lg bg-ink-900 px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50"
                    >
                      {busy === `${s.id}:ndr` && <Spinner className="mr-1" />}
                      Try again
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-gray-400">
                  Nothing here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-gray-300 px-2 py-1 disabled:opacity-40">
            ← Prev
          </button>
          <span>
            {page} / {pages}
          </span>
          <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-gray-300 px-2 py-1 disabled:opacity-40">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
