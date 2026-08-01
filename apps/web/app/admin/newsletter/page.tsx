'use client';

import { useEffect, useState } from 'react';
import type { NewsletterSubscriberRow } from '@clowe/shared';
import { api } from '@/lib/api';

export default function AdminNewsletterPage() {
  const [rows, setRows] = useState<NewsletterSubscriberRow[] | null>(null);

  useEffect(() => {
    api<NewsletterSubscriberRow[]>('/api/admin/newsletter', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  function exportCsv() {
    if (!rows?.length) return;
    const csv = ['email,subscribed_at', ...rows.map((r) => `${r.email},${r.createdAt}`)].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `clowe-newsletter-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Newsletter subscribers</h1>
          <p className="mt-1 text-sm text-gray-500">
            Emails collected from the landing-page signup. {rows ? `${rows.length} total.` : ''}
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={!rows?.length}
          className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          ⬇ Export CSV
        </button>
      </div>

      <div className="mt-5 overflow-x-auto rounded-2xl border border-gray-100 bg-white">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Subscribed</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={2} className="px-4 py-6 text-gray-500">Loading…</td></tr>
            )}
            {rows?.length === 0 && (
              <tr><td colSpan={2} className="px-4 py-6 text-gray-500">No subscribers yet.</td></tr>
            )}
            {rows?.map((row) => (
              <tr key={row.id} className="border-b border-gray-50">
                <td className="px-4 py-2.5 font-medium">{row.email}</td>
                <td className="px-4 py-2.5 text-gray-500">{new Date(row.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
