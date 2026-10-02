'use client';

import { useEffect, useState } from 'react';
import type { CspReportRow } from '@clowe/shared';
import { api } from '@/lib/api';

/**
 * What the Content-Security-Policy would block (Report-Only) or did block
 * (enforced), as browsers report it, grouped by directive, source and page.
 * The policy goes from Report-Only to enforced once this list shows nothing
 * the site itself needs.
 */
export default function AdminCspReportsPage() {
  const [rows, setRows] = useState<CspReportRow[] | null>(null);

  useEffect(() => {
    api<CspReportRow[]>('/api/admin/audit/csp-reports', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold">CSP reports</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Content-Security-Policy violations reported by visitors&rsquo; browsers, grouped. &ldquo;Report&rdquo; rows
        were only reported; &ldquo;enforce&rdquo; rows were blocked. Pages are paths only and ids are shown as
        :id. Kept for 30 days after they were last seen.
      </p>

      <div className="mt-5 overflow-x-auto rounded-2xl border border-gray-100 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-4 py-3">Directive</th>
              <th className="px-4 py-3">Blocked</th>
              <th className="px-4 py-3">Page</th>
              <th className="px-4 py-3">Mode</th>
              <th className="px-4 py-3 text-right">Count</th>
              <th className="px-4 py-3">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-gray-500">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-gray-500">
                  No violations reported.
                </td>
              </tr>
            )}
            {rows?.map((row) => (
              <tr key={row.id} className="border-b border-gray-50 align-top last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{row.directive}</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {row.blocked}
                  {row.sample && <span className="mt-1 block break-all text-gray-400">{row.sample}</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{row.page}</td>
                <td className="px-4 py-3 text-xs">{row.disposition}</td>
                <td className="px-4 py-3 text-right tabular-nums">{row.count.toLocaleString('en-IN')}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{new Date(row.lastSeenAt).toLocaleString('en-IN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
