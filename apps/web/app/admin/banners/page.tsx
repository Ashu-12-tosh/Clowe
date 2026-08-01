'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminBannerRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

const EMPTY = {
  headline: '',
  highlight: '',
  subtext: '',
  imageUrl: '',
  primaryLabel: 'Shop Now',
  primaryHref: '/products',
  secondaryLabel: '',
  secondaryHref: '',
};

export default function AdminBannersPage() {
  const [rows, setRows] = useState<AdminBannerRow[] | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<AdminBannerRow[]>('/api/admin/banners', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function addBanner(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/admin/banners', {
        body: {
          headline: form.headline.trim(),
          highlight: form.highlight.trim() || null,
          subtext: form.subtext.trim() || null,
          imageUrl: form.imageUrl.trim() || null,
          primaryLabel: form.primaryLabel.trim() || 'Shop Now',
          primaryHref: form.primaryHref.trim() || '/products',
          secondaryLabel: form.secondaryLabel.trim() || null,
          secondaryHref: form.secondaryHref.trim() || null,
          sortOrder: rows?.length ?? 0,
        },
        auth: true,
      });
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError('');
    try {
      await api(`/api/admin/banners/${id}`, { method: 'PATCH', body, auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this banner?')) return;
    try {
      await api(`/api/admin/banners/${id}`, { method: 'DELETE', auth: true });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Hero banners</h1>
      <p className="mt-1 text-sm text-gray-500">
        Slides in the landing-page carousel. The &ldquo;highlight&rdquo; word inside the headline is
        rendered in gold. Changes appear on the homepage within a minute (cached).
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          className="mt-4 rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          + New banner
        </button>
      ) : (
        <form onSubmit={(e) => void addBanner(e)} className="mt-4 grid gap-3 rounded-2xl border border-gray-100 bg-white p-4 sm:grid-cols-2">
          <input value={form.headline} onChange={set('headline')} placeholder="Headline * — e.g. Shop Everything. Smarter with AI." className={`${field} sm:col-span-2`} />
          <input value={form.highlight} onChange={set('highlight')} placeholder='Gold word — e.g. "AI."' className={field} />
          <input value={form.imageUrl} onChange={set('imageUrl')} placeholder="Image URL" className={field} />
          <input value={form.subtext} onChange={set('subtext')} placeholder="Subtext" className={`${field} sm:col-span-2`} />
          <input value={form.primaryLabel} onChange={set('primaryLabel')} placeholder="Primary button label" className={field} />
          <input value={form.primaryHref} onChange={set('primaryHref')} placeholder="Primary button link" className={field} />
          <input value={form.secondaryLabel} onChange={set('secondaryLabel')} placeholder="Secondary button label (optional)" className={field} />
          <input value={form.secondaryHref} onChange={set('secondaryHref')} placeholder="Secondary button link" className={field} />
          <div className="flex gap-2 sm:col-span-2">
            <button disabled={busy || form.headline.trim().length < 3} className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white disabled:opacity-50">
              Create
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="text-sm text-gray-500 hover:underline">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mt-5 space-y-3">
        {rows === null && <p className="text-sm text-gray-500">Loading…</p>}
        {rows?.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-4 rounded-2xl border border-gray-100 bg-white p-4">
            {row.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={row.imageUrl} alt="" className="h-16 w-24 rounded-lg object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {row.headline}{' '}
                {row.highlight && <span className="text-xs text-brand-600">(gold: {row.highlight})</span>}
              </p>
              <p className="truncate text-xs text-gray-500">
                {row.primaryLabel} → {row.primaryHref}
                {row.secondaryLabel && ` · ${row.secondaryLabel} → ${row.secondaryHref}`}
              </p>
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
