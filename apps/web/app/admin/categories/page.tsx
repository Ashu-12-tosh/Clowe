'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminCategoryRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

export default function AdminCategoriesPage() {
  const [rows, setRows] = useState<AdminCategoryRow[] | null>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<AdminCategoryRow[]>('/api/admin/categories', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  const roots = rows?.filter((r) => r.parentId === null) ?? [];
  const childrenOf = (id: string) => rows?.filter((r) => r.parentId === id) ?? [];

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/admin/categories', {
        body: { name: name.trim(), parentId: parentId || null },
        auth: true,
      });
      setName('');
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: AdminCategoryRow) {
    try {
      await api(`/api/admin/categories/${row.id}`, {
        method: 'PATCH',
        body: { isActive: !row.isActive },
        auth: true,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  function CategoryRow({ row, indent }: { row: AdminCategoryRow; indent: boolean }) {
    return (
      <div
        className={`flex items-center justify-between border-t border-gray-100 py-2 ${indent ? 'pl-6' : ''}`}
      >
        <p className="text-sm">
          <span className={row.isActive ? 'font-medium' : 'text-gray-400 line-through'}>
            {row.name}
          </span>{' '}
          <span className="text-xs text-gray-400">
            /{row.slug} · {row.productCount} products
          </span>
        </p>
        <button
          onClick={() => void toggleActive(row)}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            row.isActive
              ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              : 'bg-green-100 text-green-700 hover:bg-green-200'
          }`}
        >
          {row.isActive ? 'Deactivate' : 'Activate'}
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Categories</h1>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={(e) => void addCategory(e)} className="mt-4 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
        />
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none"
        >
          <option value="">— top level —</option>
          {roots.map((r) => (
            <option key={r.id} value={r.id}>
              under {r.name}
            </option>
          ))}
        </select>
        <button
          disabled={busy || name.trim().length < 2}
          className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          Add
        </button>
      </form>

      <div className="mt-5 rounded-2xl border border-gray-100 bg-white p-4">
        {rows === null && <p className="text-sm text-gray-500">Loading…</p>}
        {roots.map((root) => (
          <div key={root.id}>
            <CategoryRow row={root} indent={false} />
            {childrenOf(root.id).map((child) => (
              <CategoryRow key={child.id} row={child} indent />
            ))}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Deactivated categories disappear from the storefront nav/filters; their products stay but
        can be re-categorised.
      </p>
    </div>
  );
}
