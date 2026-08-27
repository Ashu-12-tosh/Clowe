'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AUDIT_SEVERITIES,
  AUDIT_SEVERITY_LABELS,
  AUDIT_STATUSES,
  AUDIT_TABS,
  AUDIT_TAB_HINTS,
  AUDIT_TAB_LABELS,
  type AuditLogPage,
  type AuditLogRow,
  type AuditSeverityValue,
  type AuditSummary,
  type AuditTab,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { DonutChart, LineChart } from '@/components/charts/Charts';

const SEVERITY_STYLES: Record<AuditSeverityValue, string> = {
  LOW: 'bg-gray-100 text-gray-600',
  MEDIUM: 'bg-yellow-100 text-yellow-700',
  HIGH: 'bg-orange-100 text-orange-700',
  CRITICAL: 'bg-red-100 text-red-700',
};

const ROLE_STYLES: Record<string, string> = {
  ADMIN: 'bg-brand-100 text-brand-700',
  SELLER: 'bg-purple-100 text-purple-700',
  CUSTOMER: 'bg-blue-100 text-blue-700',
  SYSTEM: 'bg-cream-200 text-ink-900',
  GUEST: 'bg-gray-100 text-gray-600',
};

const DEVICE_ICONS: Record<string, string> = {
  MOBILE: '📱',
  TABLET: '📲',
  DESKTOP: '🖥',
  API: '⌨️',
  OTHER: '•',
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function Delta({ change }: { change: number | null }) {
  if (change === null) return <span className="text-gray-400">no prior period</span>;
  return (
    <span className={change >= 0 ? 'text-green-600' : 'text-red-600'}>
      {change >= 0 ? '↑' : '↓'} {Math.abs(change)}% vs previous period
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
          <p className="truncate text-[11px] font-medium uppercase tracking-wide text-gray-500">
            {label}
          </p>
          <p className="mt-0.5 truncate font-display text-lg font-bold text-ink-900">{value}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">{footer}</p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <h2 className="text-sm font-bold text-ink-900">{title}</h2>
      {subtitle && <p className="text-[11px] text-gray-400">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function AdminAuditPage() {
  const [tab, setTab] = useState<AuditTab>('ALL');
  const [q, setQ] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [severity, setSeverity] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [ip, setIp] = useState('');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(isoDate(new Date()));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [data, setData] = useState<AuditLogPage | null>(null);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [openLog, setOpenLog] = useState<AuditLogRow | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams({ tab, from, to });
    if (q.trim()) p.set('q', q.trim());
    if (moduleFilter) p.set('module', moduleFilter);
    if (actionFilter) p.set('action', actionFilter);
    if (roleFilter) p.set('role', roleFilter);
    if (severity !== 'ALL') p.set('severity', severity);
    if (status !== 'ALL') p.set('status', status);
    if (ip.trim()) p.set('ip', ip.trim());
    return p.toString();
  }, [tab, q, moduleFilter, actionFilter, roleFilter, severity, status, ip, from, to]);

  const loadList = useCallback(async () => {
    try {
      setData(
        await api<AuditLogPage>(`/api/admin/audit?${query}&page=${page}&pageSize=${pageSize}`, {
          auth: true,
        }),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load audit logs');
      setData(null);
    }
  }, [query, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(
        await api<AuditSummary>(`/api/admin/audit/summary?from=${from}&to=${to}`, { auth: true }),
      );
    } catch {
      setSummary(null);
    }
  }, [from, to]);

  useEffect(() => {
    const t = setTimeout(() => void loadList(), 250);
    return () => clearTimeout(t);
  }, [loadList]);
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => setPage(1), [query, pageSize]);

  async function setRetention() {
    const current = summary?.retention.retentionDays ?? 365;
    const input = prompt('Keep audit entries for how many days? (30–3650)', String(current));
    if (!input) return;
    const days = Math.round(Number(input));
    if (!Number.isFinite(days) || days < 30 || days > 3650) {
      setError('Retention must be between 30 and 3650 days');
      return;
    }
    setBusy(true);
    try {
      await api('/api/admin/audit/retention', {
        method: 'PUT',
        body: { retentionDays: days },
        auth: true,
      });
      setNotice(`Retention set to ${days} days.`);
      await Promise.all([loadSummary(), loadList()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save retention');
    } finally {
      setBusy(false);
    }
  }

  async function purge() {
    const count = summary?.retention.purgeableCount ?? 0;
    if (count === 0) {
      setNotice('Nothing is older than the retention window.');
      return;
    }
    if (!confirm(`Permanently delete ${count} audit entries older than the retention window?`)) {
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ purged: number }>('/api/admin/audit/purge', {
        method: 'POST',
        auth: true,
      });
      setNotice(`Purged ${result.purged} entries.`);
      await Promise.all([loadSummary(), loadList()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Purge failed');
    } finally {
      setBusy(false);
    }
  }

  const k = summary?.kpis;
  const rows = data?.rows ?? null;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">
            Audit Logs &amp; Activity Monitoring
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Every state-changing request across the platform, with who did it and from where.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              void downloadFile(`/api/admin/audit/export?${query}`, 'clowe-audit-log.csv').catch(
                () => setError('Export failed'),
              )
            }
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
          >
            ⬇ Export report
          </button>
          <button
            onClick={() => void setRetention()}
            disabled={busy}
            className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            ⚙ Retention policy
          </button>
          <button
            onClick={() => void purge()}
            disabled={busy || !summary?.retention.purgeableCount}
            title={
              summary?.retention.purgeableCount
                ? `${summary.retention.purgeableCount} entries are past retention`
                : 'Nothing to purge'
            }
            className="rounded-lg bg-ink-900 px-3.5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-40"
          >
            Purge old entries
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">
          ✓ {notice}
        </p>
      )}

      {/* --- KPIs -------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {k ? (
          <>
            <KpiCard
              icon="📋"
              label="Total activities"
              value={num(k.total)}
              footer={<Delta change={k.totalChangePercent} />}
            />
            <KpiCard
              icon="🛡"
              label="Admin actions"
              value={num(k.adminActions)}
              footer={`${k.total > 0 ? Math.round((k.adminActions / k.total) * 100) : 0}% of activity`}
            />
            <KpiCard
              icon="👥"
              label="User actions"
              value={num(k.userActions)}
              footer="Sellers and customers"
            />
            <KpiCard
              icon="⚠️"
              label="Critical events"
              value={num(k.criticalEvents)}
              footer="Money, access or policy"
            />
            <KpiCard icon="🔑" label="Login activity" value={num(k.logins)} footer="Sign-in attempts" />
            <KpiCard
              icon="⛔"
              label="Failed logins"
              value={num(k.failedLogins)}
              footer={
                k.logins > 0
                  ? `${Math.round((k.failedLogins / k.logins) * 100)}% of attempts`
                  : 'None recorded'
              }
            />
            <KpiCard
              icon="✎"
              label="Data changes"
              value={num(k.dataChanges)}
              footer="Records created or edited"
            />
          </>
        ) : (
          Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      {/* --- Filters ----------------------------------------------------- */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-100 bg-white p-3">
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <span className="text-xs text-gray-400">→</span>
        <input
          type="date"
          value={to}
          min={from}
          max={isoDate(new Date())}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <select
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All modules</option>
          {summary?.filters.modules.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="max-w-44 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All actions</option>
          {summary?.filters.actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All actors</option>
          {summary?.filters.roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="ALL">All severity</option>
          {AUDIT_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {AUDIT_SEVERITY_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="ALL">All outcomes</option>
          {AUDIT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="IP address"
          className="w-28 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search LOG-…, user, detail"
          className="min-w-44 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <button
          onClick={() => {
            setQ('');
            setModuleFilter('');
            setActionFilter('');
            setRoleFilter('');
            setSeverity('ALL');
            setStatus('ALL');
            setIp('');
            setFrom(daysAgo(29));
            setTo(isoDate(new Date()));
          }}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-gray-50"
        >
          Reset
        </button>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          {/* --- Tabs ---------------------------------------------------- */}
          <div className="rounded-t-2xl border border-b-0 border-gray-100 bg-white px-3 pt-3">
            <div className="flex flex-wrap gap-1">
              {AUDIT_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  title={AUDIT_TAB_HINTS[t]}
                  className={`rounded-t-lg px-3 py-2 text-xs font-semibold ${
                    tab === t
                      ? 'border-b-2 border-brand-600 text-brand-600'
                      : 'text-gray-500 hover:text-ink-900'
                  }`}
                >
                  {AUDIT_TAB_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* --- Table --------------------------------------------------- */}
          <div className="overflow-x-auto rounded-b-2xl border border-gray-100 bg-white">
            <table className="w-full min-w-[980px] text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2.5 font-semibold">Log ID</th>
                  <th className="px-3 py-2.5 font-semibold">Timestamp</th>
                  <th className="px-3 py-2.5 font-semibold">Actor</th>
                  <th className="px-3 py-2.5 font-semibold">Module</th>
                  <th className="px-3 py-2.5 font-semibold">Action</th>
                  <th className="px-3 py-2.5 font-semibold">Details</th>
                  <th className="px-3 py-2.5 font-semibold">IP</th>
                  <th className="px-3 py-2.5 font-semibold">Severity</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 hover:bg-cream-50">
                    <td className="px-3 py-2.5 font-mono text-brand-600">{row.reference}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                      {new Date(row.createdAt).toLocaleDateString('en-IN')}
                      <span className="block text-[11px] text-gray-400">
                        {new Date(row.createdAt).toLocaleTimeString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink-900">
                        {row.actorName ?? (row.actorId ? 'Unnamed' : '—')}
                      </p>
                      <span
                        className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          ROLE_STYLES[row.actorRole] ?? 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {row.actorRole}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">{row.module}</td>
                    <td className="px-3 py-2.5 text-ink-900">{row.action}</td>
                    <td className="max-w-56 px-3 py-2.5">
                      <p className="truncate text-gray-600" title={row.summary}>
                        {row.summary}
                      </p>
                      {row.entityId && (
                        <p className="truncate font-mono text-[11px] text-gray-400">
                          {row.entityType ?? 'id'}: {row.entityId}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-gray-500">
                      <span className="font-mono">{row.ipAddress ?? '—'}</span>
                      <span className="block text-[11px] text-gray-400">
                        {DEVICE_ICONS[row.deviceType ?? 'OTHER'] ?? '•'} {row.deviceType ?? ''}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${SEVERITY_STYLES[row.severity]}`}
                      >
                        {AUDIT_SEVERITY_LABELS[row.severity]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                          row.status === 'SUCCESS'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {row.status === 'SUCCESS' ? 'Success' : 'Failed'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => setOpenLog(row)}
                        className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold hover:bg-gray-50"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
                {rows && rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-12 text-center text-gray-500">
                      No activity matches these filters.
                    </td>
                  </tr>
                )}
                {!rows && (
                  <tr>
                    <td colSpan={10} className="px-3 py-12 text-center text-gray-400">
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {data && data.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-3 py-2.5 text-xs">
                <p className="text-gray-500">
                  Showing {(data.page - 1) * data.pageSize + 1}–
                  {Math.min(data.page * data.pageSize, data.total)} of {num(data.total)} logs
                </p>
                <div className="flex items-center gap-2">
                  <button
                    disabled={data.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 font-semibold disabled:opacity-40"
                  >
                    ‹
                  </button>
                  <span className="text-gray-600">
                    Page {data.page} / {data.totalPages}
                  </span>
                  <button
                    disabled={data.page >= data.totalPages}
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
          </div>

          {/* --- Bottom charts ------------------------------------------- */}
          {summary && (
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Panel title="Activity trend" subtitle="Events recorded per day">
                  <LineChart
                    points={summary.trend.map((t) => ({ date: t.date, value: t.count }))}
                    height={160}
                  />
                </Panel>
              </div>
              <Panel title="Activities by severity">
                {summary.severity.length > 0 ? (
                  <DonutChart
                    slices={summary.severity.map((s) => ({
                      key: s.key,
                      label: s.label,
                      count: s.count,
                      share: s.share,
                    }))}
                    total={summary.kpis.total}
                    totalLabel="EVENTS"
                    size={120}
                  />
                ) : (
                  <p className="text-xs text-gray-400">Nothing recorded yet.</p>
                )}
              </Panel>

              <Panel title="Top actors" subtitle="Who generated the most activity">
                <ul className="space-y-2 text-xs">
                  {summary.topActors.map((a, i) => (
                    <li key={`${a.actorId ?? a.role}-${i}`} className="flex items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-100 text-[10px] font-bold text-gray-500">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink-900">{a.name}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          ROLE_STYLES[a.role] ?? 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {a.role}
                      </span>
                      <span className="font-semibold text-ink-900">{num(a.count)}</span>
                    </li>
                  ))}
                  {summary.topActors.length === 0 && (
                    <li className="text-gray-400">No activity yet.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="Login attempts" subtitle="Successful vs failed">
                <DonutChart
                  slices={[
                    {
                      key: 'ok',
                      label: 'Successful',
                      count: summary.loginAttempts.successful,
                      share: summary.loginAttempts.successRate,
                    },
                    {
                      key: 'failed',
                      label: 'Failed',
                      count: summary.loginAttempts.failed,
                      share: Math.round((100 - summary.loginAttempts.successRate) * 10) / 10,
                    },
                  ].filter((s) => s.count > 0)}
                  total={summary.loginAttempts.successful + summary.loginAttempts.failed}
                  totalLabel="ATTEMPTS"
                  size={120}
                />
              </Panel>

              <Panel title="Critical events" subtitle="What triggered them">
                <ul className="space-y-2 text-xs">
                  {summary.criticalBreakdown.map((c) => (
                    <li key={c.action} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-gray-700">{c.action}</span>
                      <span className="font-semibold text-red-600">{num(c.count)}</span>
                    </li>
                  ))}
                  {summary.criticalBreakdown.length === 0 && (
                    <li className="text-gray-400">No critical events in this range. 🎉</li>
                  )}
                </ul>
              </Panel>
            </div>
          )}
        </div>

        {/* --- Sidebar --------------------------------------------------- */}
        <div className="space-y-4">
          {summary && (
            <>
              <Panel title="Activity overview" subtitle="Who is acting on the platform">
                {summary.overview.length > 0 ? (
                  <DonutChart
                    slices={summary.overview.map((o) => ({
                      key: o.key,
                      label: o.label,
                      count: o.count,
                      share: o.share,
                    }))}
                    total={summary.kpis.total}
                    totalLabel="ACTIVITIES"
                    size={120}
                  />
                ) : (
                  <p className="text-xs text-gray-400">Nothing recorded yet.</p>
                )}
              </Panel>

              <Panel title="Top modules by activity">
                <ul className="space-y-2.5 text-xs">
                  {summary.topModules.map((m, i) => (
                    <li key={m.module}>
                      <button
                        onClick={() => setModuleFilter(m.module)}
                        className="w-full text-left hover:opacity-80"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-gray-700">
                            {i + 1}. {m.module}
                          </span>
                          <span className="font-semibold text-ink-900">
                            {num(m.count)}{' '}
                            <span className="font-normal text-gray-400">({m.share}%)</span>
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                          <div
                            className="h-full rounded-full bg-brand-600"
                            style={{ width: `${m.share}%` }}
                          />
                        </div>
                      </button>
                    </li>
                  ))}
                  {summary.topModules.length === 0 && (
                    <li className="text-gray-400">No activity yet.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="Recent login locations" subtitle="Sign-in attempts by IP">
                <ul className="space-y-2 text-xs">
                  {summary.loginLocations.map((l) => (
                    <li key={l.ipAddress} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-ink-900">{l.ipAddress}</p>
                        <p className="text-[11px] text-gray-400">
                          {DEVICE_ICONS[l.deviceType ?? 'OTHER'] ?? '•'} {l.deviceType ?? 'Unknown'}{' '}
                          · {fmtTime(l.lastSeen)}
                        </p>
                      </div>
                      <button
                        onClick={() => setIp(l.ipAddress)}
                        className="shrink-0 font-semibold text-brand-600 hover:underline"
                      >
                        {l.count}×
                      </button>
                    </li>
                  ))}
                  {summary.loginLocations.length === 0 && (
                    <li className="text-gray-400">No sign-ins recorded yet.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="Retention">
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Keeping logs for</dt>
                    <dd className="font-semibold text-ink-900">
                      {summary.retention.retentionDays} days
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Oldest entry</dt>
                    <dd className="text-ink-900">
                      {summary.retention.oldestEntry
                        ? new Date(summary.retention.oldestEntry).toLocaleDateString('en-IN')
                        : '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Past retention</dt>
                    <dd
                      className={
                        summary.retention.purgeableCount > 0
                          ? 'font-semibold text-orange-600'
                          : 'text-ink-900'
                      }
                    >
                      {num(summary.retention.purgeableCount)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-[11px] text-gray-400">
                  Changing retention, exporting and purging are themselves recorded.
                </p>
              </Panel>
            </>
          )}
        </div>
      </div>

      {/* --- Detail drawer ------------------------------------------------ */}
      {openLog && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-ink-900/40"
          onClick={() => setOpenLog(null)}
        >
          <aside
            className="h-full w-full max-w-md overflow-y-auto bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <p className="font-mono text-sm font-bold text-brand-600">{openLog.reference}</p>
                <p className="text-xs text-gray-500">{fmtTime(openLog.createdAt)}</p>
              </div>
              <button
                onClick={() => setOpenLog(null)}
                className="rounded-full px-3 py-1 text-sm text-gray-500 hover:bg-gray-100"
              >
                ✕
              </button>
            </header>
            <div className="space-y-4 p-5 text-xs">
              <div className="flex flex-wrap gap-2">
                <span
                  className={`rounded-full px-2.5 py-1 font-semibold ${SEVERITY_STYLES[openLog.severity]}`}
                >
                  {AUDIT_SEVERITY_LABELS[openLog.severity]}
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 font-semibold ${
                    openLog.status === 'SUCCESS'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700'
                  }`}
                >
                  {openLog.status}
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 font-semibold ${
                    ROLE_STYLES[openLog.actorRole] ?? 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {openLog.actorRole}
                </span>
              </div>

              <p className="rounded-xl bg-cream-50 px-3 py-2 text-sm text-ink-900">
                {openLog.summary}
              </p>

              <dl className="divide-y divide-gray-50">
                {[
                  ['Module', openLog.module],
                  ['Action', openLog.action],
                  ['Actor', openLog.actorName ?? '—'],
                  ['Email', openLog.actorEmail ?? '—'],
                  ['Entity', openLog.entityId ? `${openLog.entityType ?? 'record'} ${openLog.entityId}` : '—'],
                  ['IP address', openLog.ipAddress ?? '—'],
                  ['Device', openLog.deviceType ?? '—'],
                  ['Duration', openLog.durationMs != null ? `${openLog.durationMs} ms` : '—'],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3 py-1.5">
                    <dt className="shrink-0 text-gray-500">{label}</dt>
                    <dd className="min-w-0 break-words text-right text-ink-900">{value}</dd>
                  </div>
                ))}
              </dl>

              <div>
                <p className="mb-1 font-semibold text-gray-500">Request metadata</p>
                <pre className="overflow-x-auto rounded-xl bg-ink-900 p-3 text-[11px] leading-relaxed text-gray-200">
                  {JSON.stringify(openLog.metadata, null, 2)}
                </pre>
              </div>

              {openLog.userAgent && (
                <div>
                  <p className="mb-1 font-semibold text-gray-500">User agent</p>
                  <p className="break-words rounded-xl bg-cream-50 p-3 text-[11px] text-gray-600">
                    {openLog.userAgent}
                  </p>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
