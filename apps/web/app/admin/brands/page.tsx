'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminBrandRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const field =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

export default function AdminBrandsPage() {
  const [rows, setRows] = useState<AdminBrandRow[] | null>(null);
  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<AdminBrandRow[]>('/api/admin/brands', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function addBrand(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/admin/brands', {
        body: { name: name.trim(), logoUrl: logoUrl.trim() || null },
        auth: true,
      });
      setName('');
      setLogoUrl('');
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: AdminBrandRow) {
    try {
      await api(`/api/admin/brands/${row.id}`, {
        method: 'PATCH',
        body: { isActive: !row.isActive },
        auth: true,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Brands</h1>
      <p className="mt-1 text-sm text-gray-500">
        Brands power the &ldquo;Top Brands&rdquo; row on the landing page. Inactive brands are hidden
        from the storefront but keep their product links.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={(e) => void addBrand(e)} className="mt-4 flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Brand name" className={field} />
        <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="Logo URL (optional)" className={`${field} w-72`} />
        <button
          disabled={busy || name.trim().length < 2}
          className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          Add
        </button>
      </form>

      <div className="mt-5 overflow-x-auto rounded-2xl border border-gray-100 bg-white">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">Brand</th>
              <th className="px-4 py-3">Slug</th>
              <th className="px-4 py-3">Products</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={5} className="px-4 py-6 text-gray-500">Loading…</td></tr>
            )}
            {rows?.map((row) => (
              <tr key={row.id} className="border-b border-gray-50">
                <td className="px-4 py-2.5 font-semibold">
                  <span className="flex items-center gap-2">
                    {row.logoUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={row.logoUrl} alt="" className="h-6 w-6 rounded object-contain" />
                    )}
                    {row.name}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-gray-500">/{row.slug}</td>
                <td className="px-4 py-2.5">{row.productCount}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${row.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {row.isActive ? 'Active' : 'Hidden'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => void toggle(row)} className="text-xs font-semibold text-brand-600 hover:underline">
                    {row.isActive ? 'Hide' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
