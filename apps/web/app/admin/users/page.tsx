'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminUserRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const ROLES = ['ALL', 'CUSTOMER', 'SELLER', 'ADMIN'] as const;

export default function AdminUsersPage() {
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [q, setQ] = useState('');
  const [role, setRole] = useState<string>('ALL');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (role !== 'ALL') params.set('role', role);
    api<AdminUserRow[]>(`/api/admin/users?${params.toString()}`, { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [q, role]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce search
    return () => clearTimeout(t);
  }, [load]);

  async function toggleActive(user: AdminUserRow) {
    setError('');
    if (
      user.isActive &&
      !window.confirm(`Block ${user.name ?? user.phone}? They will be logged out everywhere.`)
    ) {
      return;
    }
    try {
      await api(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: { isActive: !user.isActive },
        auth: true,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Users</h1>

      <div className="mt-4 flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or phone…"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r === 'ALL' ? 'All roles' : r}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3 text-right">Orders</th>
              <th className="px-4 py-3">Joined</th>
              <th className="px-4 py-3 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((u) => (
              <tr key={u.id} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-3">
                  <p className={`font-medium ${u.isActive ? '' : 'text-gray-400'}`}>
                    {u.name ?? '—'}
                  </p>
                  <p className="text-xs text-gray-500">+91 {u.phone}</p>
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">{u.orderCount}</td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {new Date(u.createdAt).toLocaleDateString('en-IN')}
                </td>
                <td className="px-4 py-3 text-right">
                  {u.role === 'ADMIN' ? (
                    <span className="text-xs text-gray-400">—</span>
                  ) : (
                    <button
                      onClick={() => void toggleActive(u)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        u.isActive
                          ? 'bg-red-50 text-red-600 hover:bg-red-100'
                          : 'bg-green-100 text-green-700 hover:bg-green-200'
                      }`}
                    >
                      {u.isActive ? 'Block' : 'Unblock'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows === null && <p className="px-4 py-6 text-sm text-gray-500">Loading…</p>}
        {rows && rows.length === 0 && <p className="px-4 py-6 text-sm text-gray-600">No users found.</p>}
      </div>
    </div>
  );
}
