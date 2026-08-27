'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_CATEGORY_LABELS,
  DESK_PRIORITIES,
  DESK_PRIORITY_LABELS,
  DESK_SORTS,
  DESK_SORT_LABELS,
  DESK_STATUSES,
  DESK_STATUS_LABELS,
  DESK_TABS,
  DESK_TAB_LABELS,
  SLA_STATE_LABELS,
  SUPPORT_CHANNELS,
  SUPPORT_CHANNEL_LABELS,
  type DeskPriority,
  type DeskSort,
  type DeskStatus,
  type DeskTab,
  type SlaState,
  type SupportDeskPage,
  type SupportDeskSummary,
  type SupportTicketDeskDetail,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { DonutChart, LineChart } from '@/components/charts/Charts';

const STATUS_STYLES: Record<DeskStatus, string> = {
  OPEN: 'bg-yellow-100 text-yellow-700',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  PENDING_CUSTOMER: 'bg-purple-100 text-purple-700',
  RESOLVED: 'bg-green-100 text-green-700',
  CLOSED: 'bg-gray-100 text-gray-600',
};

const PRIORITY_STYLES: Record<DeskPriority, string> = {
  URGENT: 'bg-red-100 text-red-700',
  HIGH: 'bg-orange-100 text-orange-700',
  MEDIUM: 'bg-yellow-100 text-yellow-700',
  LOW: 'bg-gray-100 text-gray-600',
};

const SLA_STYLES: Record<SlaState, string> = {
  MET: 'text-green-600',
  ON_TRACK: 'text-gray-500',
  AT_RISK: 'text-orange-600',
  BREACHED: 'text-red-600',
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function num(n: number): string {
  return n.toLocaleString('en-IN');
}

function fmtMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function Delta({ change }: { change: number | null }) {
  if (change === null) return <span className="text-gray-400">no prior month</span>;
  return (
    <span className={change >= 0 ? 'text-green-600' : 'text-red-600'}>
      {change >= 0 ? '↑' : '↓'} {Math.abs(change)}% vs last month
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

export default function AdminSupportDeskPage() {
  const [tab, setTab] = useState<DeskTab>('ALL');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [channel, setChannel] = useState('');
  const [priority, setPriority] = useState('');
  const [agentId, setAgentId] = useState('');
  const [sla, setSla] = useState('ALL');
  const [sort, setSort] = useState<DeskSort>('NEWEST');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [data, setData] = useState<SupportDeskPage | null>(null);
  const [summary, setSummary] = useState<SupportDeskSummary | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string | null }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportTicketDeskDetail | null>(null);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const query = useMemo(() => {
    const p = new URLSearchParams({ tab, sort });
    if (q.trim()) p.set('q', q.trim());
    if (category) p.set('category', category);
    if (channel) p.set('channel', channel);
    if (priority) p.set('priority', priority);
    if (agentId) p.set('agentId', agentId);
    if (sla !== 'ALL') p.set('sla', sla);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString();
  }, [tab, q, category, channel, priority, agentId, sla, sort, from, to]);

  const loadList = useCallback(async () => {
    try {
      setData(
        await api<SupportDeskPage>(
          `/api/admin/support-desk?${query}&page=${page}&pageSize=${pageSize}`,
          { auth: true },
        ),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load tickets');
      setData(null);
    }
  }, [query, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<SupportDeskSummary>('/api/admin/support-desk/summary', { auth: true }));
    } catch {
      setSummary(null);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api<SupportTicketDeskDetail>(`/api/admin/support-desk/${id}`, { auth: true }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load the ticket');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadList(), 250);
    return () => clearTimeout(t);
  }, [loadList]);
  useEffect(() => {
    void loadSummary();
    api<{ id: string; name: string | null }[]>('/api/admin/support-desk/meta/agents', { auth: true })
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [loadSummary]);
  useEffect(() => setPage(1), [query, pageSize]);
  useEffect(() => setSelected(new Set()), [query, page, pageSize]);
  useEffect(() => {
    if (openId) void loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  async function patchTicket(id: string, body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/admin/support-desk/${id}`, { method: 'PATCH', body, auth: true });
      await Promise.all([loadList(), loadSummary(), openId ? loadDetail(openId) : Promise.resolve()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update the ticket');
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    if (!openId || reply.trim().length === 0) return;
    setBusy(true);
    try {
      await api(`/api/admin/support-desk/${openId}/reply`, {
        method: 'POST',
        body: { body: reply.trim(), attachments: [], isInternal: internal },
        auth: true,
      });
      setReply('');
      await Promise.all([loadDetail(openId), loadList(), loadSummary()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send the reply');
    } finally {
      setBusy(false);
    }
  }

  async function bulk(action: 'ASSIGN' | 'STATUS' | 'PRIORITY', value: string) {
    if (selected.size === 0 || !value) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await api<{ updated: number; skipped: unknown[] }>(
        '/api/admin/support-desk/bulk',
        {
          method: 'POST',
          body: {
            ids: [...selected],
            action,
            ...(action === 'ASSIGN' ? { assignedToId: value === 'UNASSIGN' ? '' : value } : {}),
            ...(action === 'STATUS' ? { status: value } : {}),
            ...(action === 'PRIORITY' ? { priority: value } : {}),
          },
          auth: true,
        },
      );
      setNotice(`${result.updated} ticket(s) updated.`);
      setSelected(new Set());
      await Promise.all([loadList(), loadSummary()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Bulk action failed');
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
            Customer Support &amp; Tickets
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Every customer query, with its SLA clock, owner and conversation.
          </p>
        </div>
        <button
          onClick={() =>
            void downloadFile(
              `/api/admin/support-desk/meta/export?${query}`,
              'clowe-support-tickets.csv',
            ).catch(() => setError('Export failed'))
          }
          className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
        >
          ⬇ Export report
        </button>
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
              icon="🎫"
              label="Total tickets"
              value={num(k.total)}
              footer={<Delta change={k.totalChangePercent} />}
            />
            <KpiCard icon="📬" label="Open" value={num(k.open)} footer="Nobody has replied yet" />
            <KpiCard
              icon="⏳"
              label="In progress"
              value={num(k.inProgress)}
              footer="Agent is on it"
            />
            <KpiCard
              icon="⌛"
              label="Pending customer"
              value={num(k.pendingCustomer)}
              footer="Waiting on the shopper"
            />
            <KpiCard icon="✅" label="Resolved" value={num(k.resolved)} footer="Settled tickets" />
            <KpiCard
              icon="🎯"
              label="SLA met"
              value={`${k.slaMetPercent}%`}
              footer="First reply inside target"
            />
            <KpiCard
              icon="⏱"
              label="Median resolution"
              value={fmtMinutes(k.avgResolutionMinutes)}
              footer="Creation to resolved"
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
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search ticket ID, customer, order, text…"
          className="min-w-48 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All categories</option>
          {COMPLAINT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {COMPLAINT_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All channels</option>
          {SUPPORT_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {SUPPORT_CHANNEL_LABELS[c]}
            </option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All priorities</option>
          {DESK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {DESK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="max-w-36 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All agents</option>
          <option value="UNASSIGNED">Unassigned</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name ?? 'Admin'}
            </option>
          ))}
        </select>
        <select
          value={sla}
          onChange={(e) => setSla(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="ALL">All SLA</option>
          <option value="BREACHED">Breached</option>
          <option value="AT_RISK">At risk</option>
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as DeskSort)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          {DESK_SORTS.map((s) => (
            <option key={s} value={s}>
              {DESK_SORT_LABELS[s]}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setQ('');
            setCategory('');
            setChannel('');
            setPriority('');
            setAgentId('');
            setSla('ALL');
            setFrom('');
            setTo('');
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
              {DESK_TABS.map((t) => {
                const count =
                  t === 'ALL'
                    ? summary?.kpis.total
                    : summary?.byStatus.find((s) => s.key === t)?.count;
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`rounded-t-lg px-3 py-2 text-xs font-semibold ${
                      tab === t
                        ? 'border-b-2 border-brand-600 text-brand-600'
                        : 'text-gray-500 hover:text-ink-900'
                    }`}
                  >
                    {DESK_TAB_LABELS[t]}
                    {count != null && count > 0 && (
                      <span className="ml-1 text-gray-400">({num(count)})</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* --- Bulk bar ------------------------------------------------ */}
          <div className="flex flex-wrap items-center gap-2 border-x border-gray-100 bg-cream-50 px-3 py-2 text-xs">
            <span className="font-semibold text-ink-900">{selected.size} selected</span>
            <select
              disabled={busy || selected.size === 0}
              onChange={(e) => {
                if (e.target.value) void bulk('ASSIGN', e.target.value);
                e.target.value = '';
              }}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 outline-none disabled:opacity-50"
            >
              <option value="">Assign to…</option>
              <option value="UNASSIGN">Unassign</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? 'Admin'}
                </option>
              ))}
            </select>
            <select
              disabled={busy || selected.size === 0}
              onChange={(e) => {
                if (e.target.value) void bulk('STATUS', e.target.value);
                e.target.value = '';
              }}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 outline-none disabled:opacity-50"
            >
              <option value="">Set status…</option>
              {DESK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {DESK_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              disabled={busy || selected.size === 0}
              onChange={(e) => {
                if (e.target.value) void bulk('PRIORITY', e.target.value);
                e.target.value = '';
              }}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 outline-none disabled:opacity-50"
            >
              <option value="">Set priority…</option>
              {DESK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {DESK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>

          {/* --- Table --------------------------------------------------- */}
          <div className="overflow-x-auto rounded-b-2xl border border-gray-100 bg-white">
            <table className="w-full min-w-[980px] text-xs">
              <thead>
                <tr className="text-left uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={!!rows && rows.length > 0 && selected.size === rows.length}
                      onChange={() =>
                        setSelected((prev) =>
                          rows && prev.size === rows.length
                            ? new Set()
                            : new Set((rows ?? []).map((r) => r.id)),
                        )
                      }
                      className="h-3.5 w-3.5 accent-[#B8860B]"
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">Ticket</th>
                  <th className="px-3 py-2.5 font-semibold">Customer</th>
                  <th className="px-3 py-2.5 font-semibold">Subject</th>
                  <th className="px-3 py-2.5 font-semibold">Channel</th>
                  <th className="px-3 py-2.5 font-semibold">Priority</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold">Assigned</th>
                  <th className="px-3 py-2.5 font-semibold">SLA</th>
                  <th className="px-3 py-2.5 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 hover:bg-cream-50">
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          })
                        }
                        className="h-3.5 w-3.5 accent-[#B8860B]"
                        aria-label={`Select ${row.reference}`}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => setOpenId(row.id)}
                        className="font-mono font-semibold text-brand-600 hover:underline"
                      >
                        {row.reference}
                      </button>
                      <p className="text-[11px] text-gray-400">
                        {new Date(row.createdAt).toLocaleDateString('en-IN')}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink-900">{row.customer.name ?? 'Customer'}</p>
                      <p className="text-[11px] text-gray-400">
                        {row.customer.email ?? `+91 ${row.customer.phone}`}
                      </p>
                    </td>
                    <td className="max-w-52 px-3 py-2.5">
                      <p className="truncate text-ink-900">{row.subject}</p>
                      <p className="text-[11px] text-gray-400">
                        {row.categoryLabel}
                        {row.orderNumber && ` · ${row.orderNumber}`}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">{row.channelLabel}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${PRIORITY_STYLES[row.priority]}`}
                      >
                        {DESK_PRIORITY_LABELS[row.priority]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLES[row.status]}`}
                      >
                        {row.statusLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <select
                        value={row.assignedTo?.id ?? ''}
                        onChange={(e) => void patchTicket(row.id, { assignedToId: e.target.value })}
                        disabled={busy}
                        className="max-w-28 rounded-lg border border-gray-300 bg-white px-2 py-1 text-[11px] outline-none disabled:opacity-50"
                      >
                        <option value="">Unassigned</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name ?? 'Admin'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`font-semibold ${SLA_STYLES[row.slaState]}`}>
                        {SLA_STATE_LABELS[row.slaState]}
                      </span>
                      <span className="block text-[11px] text-gray-400">
                        {row.firstResponseMinutes !== null
                          ? `replied in ${fmtMinutes(row.firstResponseMinutes)}`
                          : row.slaDueAt
                            ? `due ${new Date(row.slaDueAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                            : ''}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => setOpenId(row.id)}
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
                      No tickets match these filters.
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
                  {Math.min(data.page * data.pageSize, data.total)} of {num(data.total)} tickets
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
                    {[10, 25, 50].map((n) => (
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
                <Panel title="Ticket trend" subtitle="Created vs resolved per day">
                  <LineChart
                    points={summary.trend.map((t) => ({ date: t.date, value: t.created }))}
                    height={150}
                  />
                  <p className="mt-1 text-[11px] text-gray-400">
                    Created {num(summary.trend.reduce((s, t) => s + t.created, 0))} · Resolved{' '}
                    {num(summary.trend.reduce((s, t) => s + t.resolved, 0))} in the last 30 days
                  </p>
                </Panel>
              </div>

              <Panel title="Satisfaction" subtitle="From customer ratings">
                {summary.satisfaction.average != null ? (
                  <>
                    <p className="font-display text-2xl font-bold text-ink-900">
                      {summary.satisfaction.average}
                      <span className="text-sm font-normal text-gray-400"> / 5</span>
                    </p>
                    <p className="text-[11px] text-gray-400">
                      From {summary.satisfaction.ratedCount} rating(s)
                    </p>
                    <ul className="mt-3 space-y-1.5">
                      {summary.satisfaction.distribution.map((d) => (
                        <li key={d.stars} className="flex items-center gap-2 text-[11px]">
                          <span className="w-8 text-gray-500">{d.stars}★</span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cream-100">
                            <div
                              className="h-full rounded-full bg-brand-600"
                              style={{ width: `${d.share}%` }}
                            />
                          </div>
                          <span className="w-8 text-right text-gray-500">{d.count}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-xs text-gray-400">
                    No ratings yet — customers rate a ticket once it is resolved.
                  </p>
                )}
              </Panel>

              <Panel title="Agents" subtitle="Load and responsiveness">
                <ul className="space-y-2 text-xs">
                  {summary.agents.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-ink-900">
                        {a.name ?? 'Admin'}
                      </span>
                      <span className="text-gray-400">
                        {a.openTickets} open · {a.resolvedTickets} done
                      </span>
                      <span className="w-14 text-right font-semibold text-ink-900">
                        {fmtMinutes(a.medianResponseMinutes)}
                      </span>
                    </li>
                  ))}
                  {summary.agents.length === 0 && (
                    <li className="text-gray-400">No admin accounts found.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="Recent feedback" subtitle="What customers said">
                <ul className="space-y-2.5 text-xs">
                  {summary.recentFeedback.map((f) => (
                    <li key={f.id}>
                      <p className="text-ink-900">
                        {'★'.repeat(f.rating)}
                        <span className="text-gray-300">{'★'.repeat(5 - f.rating)}</span>{' '}
                        <span className="text-gray-400">{f.customerName ?? 'Customer'}</span>
                      </p>
                      {f.comment && <p className="text-gray-500">“{f.comment}”</p>}
                      <p className="text-[11px] text-gray-400">
                        {f.reference} · {SUPPORT_CHANNEL_LABELS[f.channel]}
                      </p>
                    </li>
                  ))}
                  {summary.recentFeedback.length === 0 && (
                    <li className="text-gray-400">No feedback yet.</li>
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
              <Panel title="Tickets by status">
                {summary.byStatus.length > 0 ? (
                  <DonutChart
                    slices={summary.byStatus.map((s) => ({
                      key: s.key,
                      label: s.label,
                      count: s.count,
                      share: s.share,
                    }))}
                    total={summary.kpis.total}
                    totalLabel="TICKETS"
                    size={120}
                  />
                ) : (
                  <p className="text-xs text-gray-400">No tickets yet.</p>
                )}
              </Panel>

              <Panel title="Tickets by channel">
                <ul className="space-y-2.5 text-xs">
                  {summary.byChannel.map((c) => (
                    <li key={c.key}>
                      <button
                        onClick={() => setChannel(c.key)}
                        className="w-full text-left hover:opacity-80"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-gray-700">{c.label}</span>
                          <span className="font-semibold text-ink-900">
                            {num(c.count)}{' '}
                            <span className="font-normal text-gray-400">({c.share}%)</span>
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                          <div
                            className="h-full rounded-full bg-brand-600"
                            style={{ width: `${c.share}%` }}
                          />
                        </div>
                      </button>
                    </li>
                  ))}
                  {summary.byChannel.length === 0 && (
                    <li className="text-gray-400">No tickets yet.</li>
                  )}
                </ul>
              </Panel>

              <Panel title="SLA performance" subtitle="First reply inside the target">
                <p className="font-display text-2xl font-bold text-ink-900">
                  {summary.sla.metPercent}%
                </p>
                <dl className="mt-2 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-green-600">Met</dt>
                    <dd className="font-semibold">{num(summary.sla.met)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-red-600">Breached</dt>
                    <dd className="font-semibold">{num(summary.sla.breached)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Still running</dt>
                    <dd className="font-semibold">{num(summary.sla.inFlight)}</dd>
                  </div>
                </dl>
                {summary.sla.breached > 0 && (
                  <button
                    onClick={() => setSla('BREACHED')}
                    className="mt-2 w-full rounded-lg border border-red-200 py-1.5 text-[11px] font-semibold text-red-600 hover:bg-red-50"
                  >
                    Show breached tickets
                  </button>
                )}
              </Panel>

              <Panel title="Top issue categories">
                <ul className="space-y-2.5 text-xs">
                  {summary.byCategory.map((c) => (
                    <li key={c.key}>
                      <button
                        onClick={() => setCategory(c.key)}
                        className="w-full text-left hover:opacity-80"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-gray-700">{c.label}</span>
                          <span className="font-semibold text-ink-900">
                            {num(c.count)}{' '}
                            <span className="font-normal text-gray-400">({c.share}%)</span>
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                          <div
                            className="h-full rounded-full bg-brand-600"
                            style={{ width: `${c.share}%` }}
                          />
                        </div>
                      </button>
                    </li>
                  ))}
                  {summary.byCategory.length === 0 && (
                    <li className="text-gray-400">No tickets yet.</li>
                  )}
                </ul>
              </Panel>
            </>
          )}
        </div>
      </div>

      {/* --- Ticket drawer ------------------------------------------------ */}
      {openId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-ink-900/40" onClick={() => setOpenId(null)}>
          <aside
            className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
              <div className="min-w-0">
                <p className="font-mono text-sm font-bold text-brand-600">
                  {detail?.reference ?? 'Loading…'}
                </p>
                <p className="truncate text-sm font-semibold text-ink-900">{detail?.subject}</p>
                {detail && (
                  <p className="text-[11px] text-gray-500">
                    {detail.customer.name ?? 'Customer'} · +91 {detail.customer.phone}
                    {detail.orderNumber && ` · ${detail.orderNumber}`}
                  </p>
                )}
              </div>
              <button
                onClick={() => setOpenId(null)}
                className="rounded-full px-3 py-1 text-sm text-gray-500 hover:bg-gray-100"
              >
                ✕
              </button>
            </header>

            {detail && (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-5 py-2.5 text-xs">
                  <select
                    value={detail.status}
                    onChange={(e) => void patchTicket(detail.id, { status: e.target.value })}
                    disabled={busy}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1 outline-none"
                  >
                    {DESK_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {DESK_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                  <select
                    value={detail.priority}
                    onChange={(e) => void patchTicket(detail.id, { priority: e.target.value })}
                    disabled={busy}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1 outline-none"
                  >
                    {DESK_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {DESK_PRIORITY_LABELS[p]}
                      </option>
                    ))}
                  </select>
                  <select
                    value={detail.assignedTo?.id ?? ''}
                    onChange={(e) => void patchTicket(detail.id, { assignedToId: e.target.value })}
                    disabled={busy}
                    className="rounded-lg border border-gray-300 bg-white px-2 py-1 outline-none"
                  >
                    <option value="">Unassigned</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name ?? 'Admin'}
                      </option>
                    ))}
                  </select>
                  <span className={`font-semibold ${SLA_STYLES[detail.slaState]}`}>
                    SLA {SLA_STATE_LABELS[detail.slaState]}
                  </span>
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto p-5">
                  {detail.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
                        m.isInternal
                          ? 'ml-auto border border-dashed border-yellow-300 bg-yellow-50 text-ink-900'
                          : m.authorRole === 'AGENT'
                            ? 'ml-auto bg-ink-900 text-white'
                            : 'bg-cream-100 text-ink-900'
                      }`}
                    >
                      {m.isInternal && (
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-yellow-700">
                          Internal note — not sent to the customer
                        </p>
                      )}
                      <p className="whitespace-pre-line">{m.body}</p>
                      <p
                        className={`mt-1 text-[10px] ${
                          m.authorRole === 'AGENT' && !m.isInternal ? 'text-gray-300' : 'text-gray-500'
                        }`}
                      >
                        {m.authorRole === 'CUSTOMER'
                          ? (detail.customer.name ?? 'Customer')
                          : (m.authorName ?? 'Agent')}{' '}
                        · {new Date(m.createdAt).toLocaleString('en-IN')}
                      </p>
                    </div>
                  ))}

                  {detail.customerHistory.length > 0 && (
                    <div className="rounded-xl bg-cream-50 p-3 text-xs">
                      <p className="font-semibold text-ink-900">
                        Earlier tickets from this customer
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {detail.customerHistory.map((h) => (
                          <li key={h.id}>
                            <button
                              onClick={() => setOpenId(h.id)}
                              className="text-left text-gray-600 hover:text-brand-600"
                            >
                              <span className="font-mono">{h.reference}</span> · {h.subject} (
                              {DESK_STATUS_LABELS[h.status]})
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-100 p-4">
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={3}
                    placeholder={
                      internal ? 'Internal note for the team…' : 'Reply to the customer…'
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
                  />
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        checked={internal}
                        onChange={(e) => setInternal(e.target.checked)}
                        className="h-3.5 w-3.5 accent-[#B8860B]"
                      />
                      Internal note
                    </label>
                    <button
                      onClick={() => void sendReply()}
                      disabled={busy || reply.trim().length === 0}
                      className="rounded-lg bg-ink-900 px-5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
                    >
                      {busy ? 'Sending…' : internal ? 'Save note' : 'Send reply'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
