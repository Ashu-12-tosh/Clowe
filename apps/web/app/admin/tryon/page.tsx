'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  TRYON_DEVICE_LABELS,
  TRYON_DEVICE_TYPES,
  TRYON_MONITOR_TABS,
  TRYON_MONITOR_TAB_LABELS,
  type AdminTryOnFilterOptions,
  type AdminTryOnOverview,
  type AdminTryOnRequestPage,
  type AdminTryOnRequestRow,
  type AdminTryOnSettings,
  type TryOnMonitorTab,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BarList, DonutChart, LineChart, colorAt } from '@/components/charts/Charts';
import RequestDrawer from '@/components/admin/tryon/RequestDrawer';
import SettingsModal, { type SettingsMode } from '@/components/admin/tryon/SettingsModal';

const REFRESH_MS = 30000;

const STATUS_STYLES: Record<string, string> = {
  SUCCESS: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
};

const HEALTH_STYLES: Record<string, string> = {
  OPERATIONAL: 'text-green-600',
  DEGRADED: 'text-yellow-600',
  DOWN: 'text-red-600',
};

const GENDER_OPTIONS = [
  { value: 'MALE', label: 'Men' },
  { value: 'FEMALE', label: 'Women' },
  { value: 'OTHER', label: 'Other' },
  { value: 'UNSPECIFIED', label: 'Not specified' },
];

interface Filters {
  from: string;
  to: string;
  provider: string;
  categoryId: string;
  gender: string;
  device: string;
  status: string;
  q: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

const DEFAULT_FILTERS: Filters = {
  from: daysAgo(29),
  to: isoDate(new Date()),
  provider: '',
  categoryId: '',
  gender: '',
  device: '',
  status: '',
  q: '',
};

const PRESETS: { label: string; days: number }[] = [
  { label: '7D', days: 6 },
  { label: '30D', days: 29 },
  { label: '90D', days: 89 },
];

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/** ↑/↓ delta against the previous window of the same length. */
function Delta({ change, invert = false }: { change: number | null; invert?: boolean }) {
  if (change === null) return <span className="text-gray-400">no prior data</span>;
  const good = invert ? change <= 0 : change >= 0;
  return (
    <span className={good ? 'text-green-600' : 'text-red-600'}>
      {change >= 0 ? '↑' : '↓'} {Math.abs(change)}%
    </span>
  );
}

function KpiCard({
  icon,
  label,
  value,
  footer,
}: {
  icon: string;
  label: string;
  value: string;
  footer: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cream-100 text-base">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-gray-500">
            {label}
          </p>
          <p className="mt-0.5 truncate font-display text-xl font-bold text-ink-900">{value}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">{footer}</p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-ink-900">{title}</h2>
          {subtitle && <p className="text-[11px] text-gray-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function AdminTryOnMonitorPage() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [tab, setTab] = useState<TryOnMonitorTab>('RECENT');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [overview, setOverview] = useState<AdminTryOnOverview | null>(null);
  const [requests, setRequests] = useState<AdminTryOnRequestPage | null>(null);
  const [options, setOptions] = useState<AdminTryOnFilterOptions | null>(null);
  const [settings, setSettings] = useState<AdminTryOnSettings | null>(null);

  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [openRequestId, setOpenRequestId] = useState<string | null>(null);
  const [settingsMode, setSettingsMode] = useState<SettingsMode | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value);
    }
    return params.toString();
  }, [filters]);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api<AdminTryOnOverview>(`/api/admin/tryon/overview?${query}`, { auth: true }));
      setRefreshedAt(new Date());
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load try-on analytics');
    }
  }, [query]);

  const loadRequests = useCallback(async () => {
    try {
      setRequests(
        await api<AdminTryOnRequestPage>(
          `/api/admin/tryon/requests?${query}&tab=${tab}&page=${page}&pageSize=${pageSize}`,
          { auth: true },
        ),
      );
    } catch {
      setRequests(null);
    }
  }, [query, tab, page, pageSize]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    api<AdminTryOnFilterOptions>('/api/admin/tryon/filters', { auth: true })
      .then(setOptions)
      .catch(() => setOptions(null));
    api<AdminTryOnSettings>('/api/admin/tryon/settings', { auth: true })
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  // Live monitoring: re-poll both panels while the tab is in the foreground.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadOverview();
      void loadRequests();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, loadOverview, loadRequests]);

  // Any filter/tab change restarts pagination.
  useEffect(() => setPage(1), [query, tab, pageSize]);

  function patch(next: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...next }));
  }

  function applyPreset(days: number) {
    patch({ from: daysAgo(days), to: isoDate(new Date()) });
  }

  function onRowChanged(row: AdminTryOnRequestRow) {
    setRequests((prev) =>
      prev ? { ...prev, rows: prev.rows.map((r) => (r.id === row.id ? row : r)) } : prev,
    );
    void loadOverview();
  }

  const k = overview?.kpis;
  const categoryTree = options?.categories ?? [];

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">✦ AI Try-On Monitor</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Usage, quality, cost and system health for AI Try-On — computed live from run history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              void downloadFile(
                `/api/admin/tryon/export?${query}&tab=${tab}`,
                `clowe-tryon-${filters.from}-to-${filters.to}.csv`,
              ).catch(() => setError('Export failed'))
            }
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            ⬇ Export report
          </button>
          <button
            onClick={() => setSettingsMode('MODEL')}
            disabled={!settings}
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            ⚙ Model settings
          </button>
          <button
            onClick={() => setSettingsMode('LIMITS')}
            disabled={!settings}
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            ▤ Usage limits
          </button>
          <Link
            href="/tryon"
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700"
          >
            ✦ Try-On playground
          </Link>
        </div>
      </div>

      {settings && !settings.enabled && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          AI Try-On is currently <span className="font-bold">paused</span> — shoppers cannot start
          new runs. Re-enable it under Model settings.
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* --- KPI cards -------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {k ? (
          <>
            <KpiCard
              icon="👕"
              label="Total try-ons"
              value={num(k.total.value)}
              footer={<><Delta change={k.total.changePercent} /> vs previous {overview!.range.days}d</>}
            />
            <KpiCard
              icon="👥"
              label="Unique users"
              value={num(k.uniqueUsers.value)}
              footer={<><Delta change={k.uniqueUsers.changePercent} /> vs previous period</>}
            />
            <KpiCard
              icon="✅"
              label="Successful"
              value={num(k.success.value)}
              footer={<span className="text-green-600">{k.successRate}% success rate</span>}
            />
            <KpiCard
              icon="⚠️"
              label="Failed"
              value={num(k.failed.value)}
              footer={<span className="text-red-600">{k.failureRate}% failure rate</span>}
            />
            <KpiCard
              icon="₹"
              label="Provider cost"
              value={formatPaise(k.costPaise.value)}
              footer={<><Delta change={k.costPaise.changePercent} invert /> vs previous period</>}
            />
            <KpiCard
              icon="⏱"
              label="Avg generation"
              value={k.avgDurationMs.value ? seconds(k.avgDurationMs.value) : '—'}
              footer={<><Delta change={k.avgDurationMs.changePercent} invert /> vs previous period</>}
            />
          </>
        ) : (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      {/* --- Filters ---------------------------------------------------- */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-100 bg-white p-3">
        <input
          type="date"
          value={filters.from}
          max={filters.to}
          onChange={(e) => patch({ from: e.target.value })}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <span className="text-xs text-gray-400">→</span>
        <input
          type="date"
          value={filters.to}
          min={filters.from}
          max={isoDate(new Date())}
          onChange={(e) => patch({ to: e.target.value })}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => applyPreset(p.days)}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
              filters.from === daysAgo(p.days) && filters.to === isoDate(new Date())
                ? 'bg-ink-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {p.label}
          </button>
        ))}

        <select
          value={filters.provider}
          onChange={(e) => patch({ provider: e.target.value })}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All models</option>
          {options?.providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.provider} ({num(p.count)})
            </option>
          ))}
        </select>

        <select
          value={filters.categoryId}
          onChange={(e) => patch({ categoryId: e.target.value })}
          className="max-w-44 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All categories</option>
          {categoryTree
            .filter((c) => !c.parentId)
            .map((parent) => (
              <optgroup key={parent.id} label={parent.name}>
                <option value={parent.id}>{parent.name} (all)</option>
                {categoryTree
                  .filter((c) => c.parentId === parent.id)
                  .map((child) => (
                    <option key={child.id} value={child.id}>
                      {child.name}
                    </option>
                  ))}
              </optgroup>
            ))}
        </select>

        <select
          value={filters.gender}
          onChange={(e) => patch({ gender: e.target.value })}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All genders</option>
          {GENDER_OPTIONS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>

        <select
          value={filters.device}
          onChange={(e) => patch({ device: e.target.value })}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All devices</option>
          {TRYON_DEVICE_TYPES.map((d) => (
            <option key={d} value={d}>
              {TRYON_DEVICE_LABELS[d]}
            </option>
          ))}
        </select>

        <select
          value={filters.status}
          onChange={(e) => patch({ status: e.target.value })}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All statuses</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILED">Failed</option>
          <option value="PENDING">Pending</option>
        </select>

        <input
          value={filters.q}
          onChange={(e) => patch({ q: e.target.value })}
          placeholder="Search TR-…, shopper, product"
          className="min-w-48 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
        />

        <button
          onClick={() => setFilters(DEFAULT_FILTERS)}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-gray-50"
        >
          Reset
        </button>

        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-gray-500">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="h-3.5 w-3.5 accent-[#B8860B]"
          />
          Live ({REFRESH_MS / 1000}s)
          {refreshedAt && <span className="text-gray-400">· {refreshedAt.toLocaleTimeString('en-IN')}</span>}
        </label>
      </div>

      {/* --- Main grid --------------------------------------------------- */}
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {/* Requests table */}
        <div className="xl:col-span-2">
          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="flex flex-wrap gap-1 border-b border-gray-100 px-3 pt-3">
              {TRYON_MONITOR_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-t-lg px-3 py-2 text-xs font-semibold ${
                    tab === t
                      ? 'border-b-2 border-brand-600 text-brand-600'
                      : 'text-gray-500 hover:text-ink-900'
                  }`}
                >
                  {TRYON_MONITOR_TAB_LABELS[t]}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead>
                  <tr className="text-left uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2.5 font-semibold">Request ID</th>
                    <th className="px-3 py-2.5 font-semibold">User</th>
                    <th className="px-3 py-2.5 font-semibold">Product / category</th>
                    <th className="px-3 py-2.5 font-semibold">Model</th>
                    <th className="px-3 py-2.5 font-semibold">Input</th>
                    <th className="px-3 py-2.5 font-semibold">Output</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="px-3 py-2.5 font-semibold">Time</th>
                    <th className="px-3 py-2.5 font-semibold">Requested on</th>
                    <th className="px-3 py-2.5 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {requests?.rows.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100 hover:bg-cream-50">
                      <td className="px-3 py-2 font-mono font-semibold text-brand-600">
                        {r.requestId}
                        {r.flagged && <span title={r.flagReason ?? 'Flagged'}> 🚩</span>}
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium text-ink-900">{r.userName ?? 'Unnamed'}</p>
                        <p className="text-[11px] text-gray-400">+91 {r.userPhone}</p>
                      </td>
                      <td className="max-w-52 px-3 py-2">
                        <p className="truncate text-ink-900">{r.productTitle}</p>
                        <p className="text-[11px] text-gray-400">{r.categoryName}</p>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.provider}</td>
                      <td className="px-3 py-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.inputImageUrl}
                          alt=""
                          className="h-11 w-9 rounded border border-gray-200 object-cover"
                        />
                      </td>
                      <td className="px-3 py-2">
                        {r.resultImageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={r.resultImageUrl}
                            alt=""
                            className="h-11 w-9 rounded border border-gray-200 object-cover"
                          />
                        ) : (
                          <div className="flex h-11 w-9 items-center justify-center rounded border border-dashed border-gray-300 text-[10px] text-gray-400">
                            —
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            STATUS_STYLES[r.status] ?? 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {r.status === 'SUCCESS' ? 'Success' : r.status === 'FAILED' ? 'Failed' : 'Pending'}
                        </span>
                        {r.feedback && (
                          <span className="ml-1" title={r.feedback === 'UP' ? 'Happy with fit' : 'Poor fit'}>
                            {r.feedback === 'UP' ? '👍' : '👎'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {r.durationMs != null ? seconds(r.durationMs) : '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                        {new Date(r.createdAt).toLocaleDateString('en-IN')}
                        <span className="block text-[11px] text-gray-400">
                          {new Date(r.createdAt).toLocaleTimeString('en-IN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setOpenRequestId(r.id)}
                          className="rounded-lg border border-gray-300 px-2.5 py-1 text-[11px] font-semibold hover:bg-gray-50"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                  {requests && requests.rows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-3 py-10 text-center text-gray-500">
                        No try-on runs match these filters.
                      </td>
                    </tr>
                  )}
                  {!requests && (
                    <tr>
                      <td colSpan={10} className="px-3 py-10 text-center text-gray-400">
                        Loading…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {requests && requests.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-3 py-2.5 text-xs">
                <p className="text-gray-500">
                  Showing {(requests.page - 1) * requests.pageSize + 1}–
                  {Math.min(requests.page * requests.pageSize, requests.total)} of{' '}
                  {num(requests.total)} requests
                </p>
                <div className="flex items-center gap-2">
                  <button
                    disabled={requests.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold disabled:opacity-40"
                  >
                    ‹
                  </button>
                  <span className="text-gray-600">
                    Page {requests.page} / {requests.totalPages}
                  </span>
                  <button
                    disabled={requests.page >= requests.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold disabled:opacity-40"
                  >
                    ›
                  </button>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1 outline-none"
                  >
                    {[10, 25, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        {n} / page
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </section>

          {/* Trend + latency */}
          {overview && (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Panel title="Try-on trend" subtitle="Runs per day in the selected range">
                <LineChart points={overview.trend.map((t) => ({ date: t.date, value: t.total }))} />
              </Panel>
              <Panel title="Average generation time" subtitle="Successful runs only">
                <LineChart
                  points={overview.latency.map((t) => ({ date: t.date, value: t.avgMs }))}
                  color="#3B82F6"
                  format={(v) => `${(v / 1000).toFixed(1)}s`}
                />
              </Panel>
              <Panel title="Gender distribution" subtitle="From shopper profiles">
                <DonutChart
                  slices={overview.gender}
                  total={overview.kpis.total.value}
                  totalLabel="TRY-ONS"
                />
              </Panel>
              <Panel title="Device distribution" subtitle="Captured from the request user-agent">
                <DonutChart
                  slices={overview.devices}
                  total={overview.kpis.total.value}
                  totalLabel="TRY-ONS"
                />
              </Panel>
              <Panel title="Top users by try-ons" subtitle="Most active shoppers in this range">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left uppercase tracking-wide text-gray-500">
                        <th className="pb-2 font-semibold">#</th>
                        <th className="pb-2 font-semibold">User</th>
                        <th className="pb-2 text-right font-semibold">Runs</th>
                        <th className="pb-2 text-right font-semibold">OK</th>
                        <th className="pb-2 text-right font-semibold">Failed</th>
                        <th className="pb-2 text-right font-semibold">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.topUsers.map((u, i) => (
                        <tr key={u.userId} className="border-t border-gray-100">
                          <td className="py-1.5 text-gray-400">{i + 1}</td>
                          <td className="py-1.5">
                            {u.name ?? 'Unnamed'}
                            <span className="block text-[11px] text-gray-400">+91 {u.phone}</span>
                          </td>
                          <td className="py-1.5 text-right font-semibold">{u.total}</td>
                          <td className="py-1.5 text-right text-green-600">{u.success}</td>
                          <td className="py-1.5 text-right text-red-600">{u.failed}</td>
                          <td className="py-1.5 text-right">{u.successRate}%</td>
                        </tr>
                      ))}
                      {overview.topUsers.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-gray-400">
                            No runs in this range
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <Panel title="Most tried-on products" subtitle="With shopper fit verdicts">
                <BarList
                  numbered
                  items={overview.topProducts.map((p) => ({
                    key: p.productId,
                    label: p.title,
                    percent: overview.topProducts[0]
                      ? (p.total / overview.topProducts[0].total) * 100
                      : 0,
                    value: `${p.total} runs`,
                    hint:
                      p.upVotes + p.downVotes > 0
                        ? `👍 ${p.upVotes} · 👎 ${p.downVotes}`
                        : 'No fit ratings yet',
                  }))}
                />
              </Panel>
            </div>
          )}
        </div>

        {/* --- Sidebar --------------------------------------------------- */}
        <div className="space-y-4">
          {overview && (
            <>
              <Panel title="Try-on usage overview" subtitle={`Last ${overview.range.days} days`}>
                <DonutChart
                  slices={overview.gender}
                  total={overview.kpis.total.value}
                  totalLabel="TOTAL TRY-ONS"
                />
              </Panel>

              <Panel title="Top categories by try-ons">
                <BarList
                  numbered
                  items={overview.categories.map((c) => ({
                    key: c.key,
                    label: c.label,
                    percent: c.share,
                    value: `${num(c.count)} (${c.share}%)`,
                  }))}
                />
              </Panel>

              <Panel title="Model performance" subtitle="Success rate by provider">
                <BarList
                  items={overview.providers.map((p) => ({
                    key: p.provider,
                    label: p.provider,
                    percent: p.successRate,
                    value: `${p.successRate}%`,
                    hint: `${num(p.total)} runs · avg ${p.avgDurationMs ? seconds(p.avgDurationMs) : '—'} · ${formatPaise(p.costPaise)}`,
                  }))}
                  color="#10B981"
                />
              </Panel>

              <Panel
                title="Quality score"
                subtitle="Composite of the signals below"
                action={
                  <span className="font-display text-lg font-bold text-ink-900">
                    {overview.quality.score}
                    <span className="text-xs font-normal text-gray-400"> / 5</span>
                  </span>
                }
              >
                <BarList
                  items={overview.quality.bars.map((b) => ({
                    key: b.key,
                    label: b.label,
                    percent: b.value,
                    value: `${b.value}%`,
                    hint: b.detail,
                  }))}
                />
              </Panel>

              <Panel
                title="AI system health"
                action={
                  <span
                    className={`rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold ${
                      HEALTH_STYLES[overview.health.overall]
                    }`}
                  >
                    {overview.health.overall === 'OPERATIONAL'
                      ? 'All systems operational'
                      : overview.health.overall === 'DEGRADED'
                        ? 'Degraded'
                        : 'Attention needed'}
                  </span>
                }
              >
                <ul className="space-y-2">
                  {overview.health.checks.map((c) => (
                    <li key={c.key} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-gray-700">
                          <span className={HEALTH_STYLES[c.status]}>●</span> {c.label}
                        </span>
                        <span className={`font-semibold ${HEALTH_STYLES[c.status]}`}>
                          {c.status === 'OPERATIONAL' ? 'Operational' : c.status === 'DEGRADED' ? 'Degraded' : 'Down'}
                        </span>
                      </div>
                      <p className="mt-0.5 pl-3.5 text-[11px] text-gray-400">{c.detail}</p>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Abuse & safety" subtitle="Click a tile to filter the table">
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Flagged runs', value: overview.abuse.flagged, tab: 'FLAGGED' as TryOnMonitorTab, icon: '🚩' },
                    { label: 'Failed runs', value: overview.abuse.failed, tab: 'FAILED' as TryOnMonitorTab, icon: '⚠️' },
                    { label: 'Poor fit reports', value: overview.abuse.ratedDown, tab: 'RATED_DOWN' as TryOnMonitorTab, icon: '👎' },
                    { label: 'Quota hits', value: overview.abuse.blockedByQuota, tab: null, icon: '⛔' },
                  ].map((tile) => (
                    <button
                      key={tile.label}
                      onClick={() => tile.tab && setTab(tile.tab)}
                      disabled={!tile.tab}
                      className="rounded-xl border border-gray-100 bg-cream-50 p-3 text-left transition hover:border-brand-600 disabled:cursor-default disabled:hover:border-gray-100"
                    >
                      <p className="text-base">{tile.icon}</p>
                      <p className="mt-1 font-display text-lg font-bold text-ink-900">
                        {num(tile.value)}
                      </p>
                      <p className="text-[11px] text-gray-500">{tile.label}</p>
                    </button>
                  ))}
                </div>
              </Panel>

              <Panel title="Fit feedback" subtitle="Shopper verdicts on generated results">
                <div className="flex items-center gap-4">
                  <DonutChart
                    slices={[
                      {
                        key: 'up',
                        label: 'Happy with fit',
                        count: overview.quality.up,
                        share: overview.quality.ratedCount
                          ? Math.round((overview.quality.up / overview.quality.ratedCount) * 1000) / 10
                          : 0,
                      },
                      {
                        key: 'down',
                        label: 'Poor fit',
                        count: overview.quality.down,
                        share: overview.quality.ratedCount
                          ? Math.round((overview.quality.down / overview.quality.ratedCount) * 1000) / 10
                          : 0,
                      },
                    ]}
                    total={overview.quality.ratedCount}
                    totalLabel="RATED"
                    size={120}
                  />
                </div>
              </Panel>
            </>
          )}
          {!overview && <div className="h-64 animate-pulse rounded-2xl bg-gray-100" />}
        </div>
      </div>

      {openRequestId && (
        <RequestDrawer
          requestId={openRequestId}
          onClose={() => setOpenRequestId(null)}
          onChanged={onRowChanged}
        />
      )}

      {settingsMode && settings && (
        <SettingsModal
          mode={settingsMode}
          settings={settings}
          onClose={() => setSettingsMode(null)}
          onSaved={(next) => {
            setSettings(next);
            void loadOverview();
          }}
        />
      )}
    </div>
  );
}
