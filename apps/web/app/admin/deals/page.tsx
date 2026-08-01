'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminDealRow, AdminProductRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const field =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

/** datetime-local value (local time) for now + `plusHours`. */
function localDateTime(plusHours: number): string {
  const d = new Date(Date.now() + plusHours * 3600_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

const STATE_STYLE: Record<AdminDealRow['state'], string> = {
  LIVE: 'bg-green-100 text-green-700',
  UPCOMING: 'bg-brand-100 text-brand-700',
  ENDED: 'bg-gray-100 text-gray-500',
};

export default function AdminDealsPage() {
  const [rows, setRows] = useState<AdminDealRow[] | null>(null);
  const [products, setProducts] = useState<AdminProductRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('Deals of the Day');
  const [startAt, setStartAt] = useState(() => localDateTime(0));
  const [endAt, setEndAt] = useState(() => localDateTime(24));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<AdminDealRow[]>('/api/admin/deals', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
    api<AdminProductRow[]>('/api/admin/products?status=APPROVED', { auth: true })
      .then(setProducts)
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? products.filter((p) => p.title.toLowerCase().includes(needle) || (p.brand ?? '').toLowerCase().includes(needle))
      : products;
    return list.slice(0, 30);
  }, [products, filter]);

  async function createDeal(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/admin/deals', {
        body: {
          title: title.trim() || 'Deals of the Day',
          startAt: new Date(startAt).toISOString(),
          endAt: new Date(endAt).toISOString(),
          productIds: [...picked],
        },
        auth: true,
      });
      setShowForm(false);
      setPicked(new Set());
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/admin/deals/${id}`, { method: 'PATCH', body, auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this deal?')) return;
    try {
      await api(`/api/admin/deals/${id}`, { method: 'DELETE', auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Deals of the Day</h1>
      <p className="mt-1 text-sm text-gray-500">
        The landing page shows the deal whose window contains the current time, with a live
        countdown to its end. When it expires, the next scheduled deal takes over automatically.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          className="mt-4 rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          + Schedule a deal
        </button>
      ) : (
        <form onSubmit={(e) => void createDeal(e)} className="mt-4 rounded-2xl border border-gray-100 bg-white p-4">
          <div className="flex flex-wrap gap-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={`${field} w-56`} />
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              Starts
              <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className={field} />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              Ends
              <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} className={field} />
            </label>
          </div>

          <div className="mt-3">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search live products to add…"
              className={`${field} w-full sm:w-96`}
            />
            <div className="mt-2 grid max-h-64 gap-1 overflow-y-auto sm:grid-cols-2">
              {visible.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-cream-100">
                  <input
                    type="checkbox"
                    checked={picked.has(p.id)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        return next;
                      })
                    }
                    className="h-4 w-4 accent-brand-600"
                  />
                  {p.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.imageUrl} alt="" className="h-8 w-7 rounded object-cover" />
                  )}
                  <span className="truncate">{p.title}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-500">{picked.size} selected (max 24)</p>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              disabled={busy || picked.size === 0}
              className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white disabled:opacity-50"
            >
              Create deal
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="text-sm text-gray-500 hover:underline">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mt-5 space-y-3">
        {rows === null && <p className="text-sm text-gray-500">Loading…</p>}
        {rows?.map((deal) => (
          <div key={deal.id} className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-semibold">{deal.title}</p>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_STYLE[deal.state]}`}>
                {deal.state}
              </span>
              <span className="text-xs text-gray-500">
                {new Date(deal.startAt).toLocaleString()} → {new Date(deal.endAt).toLocaleString()}
              </span>
              <span className="ml-auto flex items-center gap-3 text-xs font-semibold">
                <button
                  onClick={() => void patch(deal.id, { isActive: !deal.isActive })}
                  className={deal.isActive ? 'text-gray-500 hover:underline' : 'text-green-600 hover:underline'}
                >
                  {deal.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => void remove(deal.id)} className="text-red-500 hover:underline">
                  Delete
                </button>
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {deal.products.map((p) => (
                <span key={p.id} className="flex items-center gap-1.5 rounded-full bg-cream-100 py-1 pl-1 pr-2.5 text-xs">
                  {p.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.imageUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                  )}
                  <span className="max-w-40 truncate">{p.title}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
