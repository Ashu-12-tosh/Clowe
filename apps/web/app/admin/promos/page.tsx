'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminPromoTileRow, PromoPlacementValue } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const field =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

export default function AdminPromosPage() {
  const [rows, setRows] = useState<AdminPromoTileRow[] | null>(null);
  const [placement, setPlacement] = useState<PromoPlacementValue>('PROMO_CARD');
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [href, setHref] = useState('/products');
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<AdminPromoTileRow[]>('/api/admin/promos', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function addTile(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/admin/promos', {
        body: {
          placement,
          title: title.trim(),
          subtitle: subtitle.trim() || null,
          href: href.trim() || '/products',
          imageUrl: imageUrl.trim() || null,
          sortOrder: rows?.filter((r) => r.placement === placement).length ?? 0,
        },
        auth: true,
      });
      setTitle('');
      setSubtitle('');
      setImageUrl('');
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/admin/promos/${id}`, { method: 'PATCH', body, auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this promo tile?')) return;
    try {
      await api(`/api/admin/promos/${id}`, { method: 'DELETE', auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  function Group({ kind, label }: { kind: PromoPlacementValue; label: string }) {
    const tiles = rows?.filter((r) => r.placement === kind) ?? [];
    return (
      <div className="mt-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-700">{label}</h2>
        <div className="mt-2 space-y-2">
          {tiles.length === 0 && <p className="text-sm text-gray-400">None yet.</p>}
          {tiles.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center gap-4 rounded-2xl border border-gray-100 bg-white p-3">
              {row.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={row.imageUrl} alt="" className="h-12 w-20 rounded-lg object-cover" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {row.title} {row.subtitle && <span className="text-brand-600">· {row.subtitle}</span>}
                </p>
                <p className="truncate text-xs text-gray-500">→ {row.href}</p>
              </div>
              <div className="flex items-center gap-3 text-xs font-semibold">
                <button
                  onClick={() => void patch(row.id, { isActive: !row.isActive })}
                  className={row.isActive ? 'text-gray-500 hover:underline' : 'text-green-600 hover:underline'}
                >
                  {row.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => void remove(row.id)} className="text-red-500 hover:underline">
                  Delete
                </button>
                <span className={`rounded-full px-2 py-0.5 ${row.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                  {row.isActive ? 'Live' : 'Off'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Promo tiles</h1>
      <p className="mt-1 text-sm text-gray-500">
        Cards = the 4-tile row near the top of the landing page. Strips = the 3 wide banners lower
        down.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={(e) => void addTile(e)} className="mt-4 flex flex-wrap gap-2">
        <select value={placement} onChange={(e) => setPlacement(e.target.value as PromoPlacementValue)} className={`${field} bg-white`}>
          <option value="PROMO_CARD">Card (top row)</option>
          <option value="PROMO_STRIP">Strip (wide)</option>
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={field} />
        <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Discount line" className={field} />
        <input value={href} onChange={(e) => setHref(e.target.value)} placeholder="Link" className={`${field} w-64`} />
        <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="Image URL" className={`${field} w-64`} />
        <button
          disabled={busy || title.trim().length < 2}
          className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          Add
        </button>
      </form>

      <Group kind="PROMO_CARD" label="Promo cards (4-tile row)" />
      <Group kind="PROMO_STRIP" label="Promo strips (wide banners)" />
    </div>
  );
}
