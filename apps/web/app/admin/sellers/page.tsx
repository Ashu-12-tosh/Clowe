'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ADMIN_SELLER_SORTS,
  ADMIN_SELLER_SORT_LABELS,
  KYC_STATUSES,
  KYC_STATUS_LABELS,
  SELLER_STATUSES,
  SELLER_STATUS_LABELS,
  type AdminSellerPage,
  type AdminSellerSort,
  type AdminSellerStatus,
  type AdminSellerSummary,
  type KycStatus,
} from '@clowe/shared';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { DonutChart, LineChart } from '@/components/charts/Charts';
import SellerDetailPanel, {
  KYC_STYLES,
  SELLER_STATUS_STYLES,
} from '@/components/admin/SellerDetailPanel';

function num(n: number): string {
  return n.toLocaleString('en-IN');
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
  onClick,
  active,
}: {
  icon: string;
  label: string;
  value: string;
  footer: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`rounded-2xl border bg-white p-4 text-left transition ${
        active ? 'border-brand-600 ring-1 ring-brand-600' : 'border-gray-100'
      } ${onClick ? 'hover:border-gray-300' : 'cursor-default'}`}
    >
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
    </button>
  );
}

function SellersView() {
  const params = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'ALL' | AdminSellerStatus>(
    (params.get('status') as AdminSellerStatus) ?? 'ALL',
  );
  const [kyc, setKyc] = useState<'ALL' | KycStatus>('ALL');
  const [city, setCity] = useState('');
  const [sort, setSort] = useState<AdminSellerSort>('NEWEST');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [data, setData] = useState<AdminSellerPage | null>(null);
  const [summary, setSummary] = useState<AdminSellerSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const query = useMemo(() => {
    const p = new URLSearchParams({ sort });
    if (q.trim()) p.set('q', q.trim());
    if (status !== 'ALL') p.set('status', status);
    if (kyc !== 'ALL') p.set('kyc', kyc);
    if (city) p.set('city', city);
    return p.toString();
  }, [q, status, kyc, city, sort]);

  const loadList = useCallback(async () => {
    try {
      setData(
        await api<AdminSellerPage>(`/api/admin/sellers?${query}&page=${page}&pageSize=${pageSize}`, {
          auth: true,
        }),
      );
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load sellers');
      setData(null);
    }
  }, [query, page, pageSize]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<AdminSellerSummary>('/api/admin/sellers/summary', { auth: true }));
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadList(), 250);
    return () => clearTimeout(t);
  }, [loadList]);
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => setPage(1), [query, pageSize]);

  const k = summary?.kpis;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Seller Management</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Verify businesses, monitor performance and act on the shops that need it.
          </p>
        </div>
        <button
          onClick={() =>
            void downloadFile(`/api/admin/sellers/export?${query}`, 'clowe-sellers.csv').catch(() =>
              setError('Export failed'),
            )
          }
          className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
        >
          ⬇ Export sellers
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* --- KPIs -------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {k ? (
          <>
            <KpiCard
              icon="🏪"
              label="Total sellers"
              value={num(k.total)}
              footer={<Delta change={k.totalChangePercent} />}
              onClick={() => setStatus('ALL')}
              active={status === 'ALL'}
            />
            <KpiCard
              icon="✅"
              label="Active"
              value={num(k.active)}
              footer={`${k.total > 0 ? Math.round((k.active / k.total) * 100) : 0}% of the roster`}
              onClick={() => setStatus('APPROVED')}
              active={status === 'APPROVED'}
            />
            <KpiCard
              icon="🛡"
              label="KYC verified"
              value={num(k.verified)}
              footer="Documents checked"
              onClick={() => setKyc('VERIFIED')}
              active={kyc === 'VERIFIED'}
            />
            <KpiCard
              icon="⏳"
              label="Pending verification"
              value={num(k.pendingVerification)}
              footer="Docs missing or under review"
              onClick={() => setKyc('UNDER_REVIEW')}
              active={kyc === 'UNDER_REVIEW'}
            />
            <KpiCard
              icon="⏸"
              label="Suspended"
              value={num(k.suspended)}
              footer="Listings hidden"
              onClick={() => setStatus('SUSPENDED')}
              active={status === 'SUSPENDED'}
            />
            <KpiCard
              icon="⊘"
              label="Banned"
              value={num(k.banned)}
              footer="Permanently off"
              onClick={() => setStatus('BANNED')}
              active={status === 'BANNED'}
            />
          </>
        ) : (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      {/* --- Filters ----------------------------------------------------- */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-100 bg-white p-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search shop, owner, phone, email, GSTIN, SEL-ID…"
          className="min-w-56 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand-600"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as 'ALL' | AdminSellerStatus)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="ALL">All statuses</option>
          {SELLER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SELLER_STATUS_LABELS[s]}
              {summary ? ` (${summary.counts[s] ?? 0})` : ''}
            </option>
          ))}
        </select>
        <select
          value={kyc}
          onChange={(e) => setKyc(e.target.value as 'ALL' | KycStatus)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="ALL">All verification</option>
          {KYC_STATUSES.map((s) => (
            <option key={s} value={s}>
              {KYC_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className="max-w-40 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="">All cities</option>
          {summary?.cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as AdminSellerSort)}
          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
        >
          {ADMIN_SELLER_SORTS.map((s) => (
            <option key={s} value={s}>
              {ADMIN_SELLER_SORT_LABELS[s]}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setQ('');
            setStatus('ALL');
            setKyc('ALL');
            setCity('');
            setSort('NEWEST');
          }}
          className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-gray-50"
        >
          Reset
        </button>
      </div>

      {/* --- Table ------------------------------------------------------- */}
      <div className="mt-4 overflow-x-auto rounded-2xl border border-gray-100 bg-white">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="text-left uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2.5 font-semibold">Seller</th>
              <th className="px-3 py-2.5 font-semibold">Seller ID</th>
              <th className="px-3 py-2.5 font-semibold">Business</th>
              <th className="px-3 py-2.5 font-semibold">Status</th>
              <th className="px-3 py-2.5 font-semibold">Verification</th>
              <th className="px-3 py-2.5 font-semibold">Joined</th>
              <th className="px-3 py-2.5 text-right font-semibold">GMV (month)</th>
              <th className="px-3 py-2.5 text-right font-semibold">Orders</th>
              <th className="px-3 py-2.5 font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((row) => (
              <tr key={row.id} className="border-t border-gray-100 hover:bg-cream-50">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-900 text-[11px] font-bold text-white">
                      {row.shopName.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="max-w-44 truncate font-medium text-ink-900">{row.shopName}</p>
                      <p className="max-w-44 truncate text-[11px] text-gray-400">
                        {row.email ?? row.ownerName ?? '—'}
                      </p>
                      <p className="text-[11px] text-gray-400">+91 {row.phone}</p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5 font-mono text-gray-600">{row.sellerId}</td>
                <td className="px-3 py-2.5 text-gray-600">
                  {row.businessType ?? '—'}
                  <span className="block text-[11px] text-gray-400">
                    {row.primaryCategory ?? 'No sales yet'}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${SELLER_STATUS_STYLES[row.status]}`}
                  >
                    {row.statusLabel}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${KYC_STYLES[row.kycStatus]}`}
                  >
                    {row.kycLabel}
                  </span>
                  {row.kycAlerts.panGstinMismatch && (
                    <span
                      title="The GSTIN carries a different PAN from the one on file"
                      className="mt-1 block whitespace-nowrap text-[11px] font-bold text-red-600"
                    >
                      ⚠ PAN–GSTIN mismatch
                    </span>
                  )}
                  {row.kycAlerts.fraudAccount && (
                    <span
                      title="The verification provider flagged the bank account as fraudulent"
                      className="mt-1 block whitespace-nowrap text-[11px] font-bold text-red-600"
                    >
                      ⚠ Fraud-flagged bank
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                  {new Date(row.joinedAt).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                  <span className="block text-[11px] text-gray-400">
                    {row.city ?? '—'}
                    {row.state ? `, ${row.state}` : ''}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <p className="font-semibold text-ink-900">{formatPaise(row.gmvMonthPaise)}</p>
                  <p className="text-[11px] text-gray-400">
                    {formatPaise(row.gmvTotalPaise)} all time
                  </p>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <p className="font-semibold text-ink-900">{row.orderCount}</p>
                  <p className="text-[11px] text-gray-400">{row.liveProductCount} live</p>
                </td>
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => setOpenId(row.id)}
                    className="rounded-lg border border-gray-300 px-3 py-1 font-semibold hover:bg-gray-50"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-12 text-center text-gray-500">
                  No sellers match these filters.
                </td>
              </tr>
            )}
            {!data && (
              <tr>
                <td colSpan={9} className="px-3 py-12 text-center text-gray-400">
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
              {Math.min(data.page * data.pageSize, data.total)} of {data.total} sellers
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

      {/* --- Charts ------------------------------------------------------ */}
      {summary && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          <section className="rounded-2xl border border-gray-100 bg-white p-4 xl:col-span-2">
            <h2 className="text-sm font-bold text-ink-900">Seller growth</h2>
            <p className="text-[11px] text-gray-400">New shops per day, last 30 days</p>
            <div className="mt-3">
              <LineChart
                points={summary.growth.map((g) => ({ date: g.date, value: g.count }))}
                height={150}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Verification</h2>
            <div className="mt-3">
              <DonutChart
                slices={summary.verification.map((v) => ({
                  key: v.key,
                  label: v.label,
                  count: v.count,
                  share: v.share,
                }))}
                total={summary.kpis.total}
                totalLabel="SELLERS"
                size={110}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Status distribution</h2>
            <div className="mt-3">
              <DonutChart
                slices={summary.statusDistribution.map((s) => ({
                  key: s.key,
                  label: s.label,
                  count: s.count,
                  share: s.share,
                }))}
                total={summary.kpis.total}
                totalLabel="SELLERS"
                size={110}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4 xl:col-span-4">
            <h2 className="text-sm font-bold text-ink-900">Top categories by GMV</h2>
            {summary.topCategories.length > 0 ? (
              <ul className="mt-3 space-y-2 text-xs">
                {summary.topCategories.map((c, i) => (
                  <li key={c.id}>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">
                        {i + 1}. {c.name}
                      </span>
                      <span className="font-semibold text-ink-900">
                        {formatPaise(c.gmvPaise)}{' '}
                        <span className="font-normal text-gray-400">({c.share}%)</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                      <div
                        className="h-full rounded-full bg-brand-600"
                        style={{ width: `${c.share}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">No sales recorded yet.</p>
            )}
          </section>
        </div>
      )}

      {openId && (
        <SellerDetailPanel
          sellerId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            void loadList();
            void loadSummary();
          }}
        />
      )}
    </div>
  );
}

/** useSearchParams needs a boundary for the client-side bailout. */
export default function AdminSellersPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
      <SellersView />
    </Suspense>
  );
}
