'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PLAN_FEATURE_LABELS, SELLER_PLANS, type SellerPlan, type SellerPlanView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const RANK: Record<SellerPlan, number> = { FREE: 0, GROWTH: 1, PRO: 2, PREMIUM: 3 };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

interface PickRow {
  id: string;
  title: string;
  planHidden: boolean;
}

/**
 * Seller plans (owner's Batch 2): FREE, GROWTH, PRO, PREMIUM — monthly,
 * auto-renewing, paid from the Seller Wallet then the next payout. Upgrade at
 * once (charged for the rest of the month), downgrade at the renewal, turn
 * auto-renew off anytime, and choose which products stay live within a limit.
 */
export default function SellerPlansPage() {
  const [view, setView] = useState<SellerPlanView | null>(null);
  const [rows, setRows] = useState<PickRow[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<SellerPlanView>('/api/seller/billing/plan', { auth: true }).then(setView).catch(() => {});
    api<PickRow[]>('/api/seller/billing/plan/products', { auth: true })
      .then((r) => {
        setRows(r);
        setPicked(r.filter((x) => !x.planHidden).map((x) => x.id));
      })
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError('');
    try {
      await fn();
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  if (!view) return <p className="text-sm text-gray-500">Loading…</p>;
  const current = view.plans[view.plan];
  const limit = current.maxLiveProducts;
  const overLimit = limit !== null && rows.length > limit;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Plans</h1>
        <p className="mt-1 text-sm text-gray-500">
          Monthly, renewing on the same date. Paid from your{' '}
          <Link href="/seller/billing" className="font-semibold text-brand-600 hover:underline">
            Seller Wallet
          </Link>{' '}
          first, then your next payout. Prices are plus {view.gstPercent}% GST.
        </p>
      </div>
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <section className="rounded-2xl border border-gray-100 bg-white p-4" data-current-plan={view.plan}>
        <p className="text-sm text-gray-600">
          You are on <span className="font-bold text-ink-900">{view.plan}</span>
          {view.periodEnd && <> · {view.autoRenew ? 'renews' : 'ends'} on {day(view.periodEnd)}</>}
          {view.pendingPlan && <> · moving to {view.pendingPlan} then</>}
        </p>
        {view.graceUntil && (
          <p className="mt-1 text-sm font-semibold text-red-700">
            Your renewal could not be paid. Top up your wallet by {day(view.graceUntil)}, or the plan moves to FREE.
          </p>
        )}
        {view.limitGraceUntil && (
          <p className="mt-1 text-xs text-amber-800">Until {day(view.limitGraceUntil)} all your products stay live whatever the plan&apos;s limit.</p>
        )}
        <p className="mt-1 text-xs text-gray-500">
          Live products: {view.liveProducts}
          {limit !== null ? ` of ${limit}` : ' (no limit)'}
          {view.hiddenByPlan > 0 ? ` · ${view.hiddenByPlan} hidden over the limit (not deleted)` : ''} · Wallet {formatPaise(view.walletPaise)}
        </p>
        {view.plan !== 'FREE' && (
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="autoRenew"
              checked={view.autoRenew}
              disabled={!!busy}
              onChange={(e) => void run('renew', () => api('/api/seller/billing/plan/auto-renew', { auth: true, body: { autoRenew: e.target.checked }, success: e.target.checked ? 'Auto-renew on' : 'Auto-renew off — the plan ends on its renewal date' }))}
            />
            Renew automatically every month
          </label>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SELLER_PLANS.map((p) => {
          const rules = view.plans[p];
          const isCurrent = p === view.plan;
          const up = RANK[p] > RANK[view.plan];
          return (
            <section key={p} className={`flex flex-col rounded-2xl border bg-white p-4 ${isCurrent ? 'border-brand-600 ring-1 ring-brand-600' : 'border-gray-100'}`} data-plan={p}>
              <h2 className="font-display text-lg font-bold text-ink-900">{p}</h2>
              <p className="text-xl font-bold text-ink-900">
                {rules.pricePaise === 0 ? '₹0' : formatPaise(rules.pricePaise)}
                <span className="text-xs font-normal text-gray-500"> /month + GST</span>
              </p>
              <ul className="mt-3 flex-1 space-y-1 text-xs text-gray-700">
                <li>{rules.maxLiveProducts === null ? 'Unlimited live products' : `Up to ${rules.maxLiveProducts} live products`}</li>
                <li>Listing, dashboard, order management and basic analytics</li>
                {rules.features.map((f) => (
                  <li key={f}>✓ {PLAN_FEATURE_LABELS[f]}</li>
                ))}
                {rules.monthlyAdCreditPaise > 0 && <li>✓ {formatPaise(rules.monthlyAdCreditPaise)} advertising credit every month</li>}
                {rules.waivesHandlingFee && <li>✓ No handling fee on your orders</li>}
              </ul>
              <button
                disabled={isCurrent || !!busy}
                onClick={() => void run(p, () => api('/api/seller/billing/plan', { auth: true, body: { plan: p }, success: up ? `You are on ${p}` : `Moving to ${p} on your renewal date` }))}
                className={`mt-3 rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wide disabled:opacity-50 ${up ? 'bg-brand-600 text-white' : 'border border-gray-300 text-ink-900'}`}
                data-action={`plan-${p}`}
              >
                {isCurrent ? 'Current plan' : busy === p ? 'Working…' : up ? 'Upgrade now' : 'Downgrade at renewal'}
              </button>
            </section>
          );
        })}
      </div>

      {overLimit && (
        <section className="rounded-2xl border border-amber-200 bg-white p-4" data-pick-live>
          <h2 className="text-sm font-bold text-ink-900">Choose which {limit} products stay live</h2>
          <p className="text-xs text-gray-500">The rest are hidden from shoppers, never deleted. Until you choose, the newest stay live.</p>
          <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto">
            {rows.map((r) => (
              <li key={r.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="liveProduct"
                    checked={picked.includes(r.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))}
                  />
                  {r.title}
                </label>
              </li>
            ))}
          </ul>
          <button
            disabled={!!busy || picked.length > (limit ?? Infinity)}
            onClick={() => void run('pick', () => api('/api/seller/billing/plan/live-products', { auth: true, body: { productIds: picked }, success: 'Saved — these stay live' }))}
            className="mt-3 rounded-lg bg-ink-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
          >
            Keep these {picked.length} live
          </button>
        </section>
      )}
    </div>
  );
}
