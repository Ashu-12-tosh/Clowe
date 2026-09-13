'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CREDIT_REASON_LABELS,
  type CreditPackage,
  type CreditPurchaseResult,
  type CreditReason,
  type CreditsInfo,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import {
  BoxIcon,
  CheckIcon,
  ClockIcon,
  HeadsetIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TagIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const PAGE_SIZE = 6;

const TABS = [
  { key: 'all', label: 'Transactions' },
  { key: 'earned', label: 'Earn Credits' },
  { key: 'used', label: 'Use Credits' },
  { key: 'expiring', label: 'Expiring Credits' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const REASON_ICON: Record<string, string> = {
  EARN_PURCHASE: '🛍',
  EARN_REFERRAL: '🎁',
  EARN_TOPUP: '🪙',
  REDEEM_CHECKOUT: '🛒',
  REFUND_CREDITS: '↩',
  EXPIRED: '⏳',
};

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns on eligible items' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function reasonLabel(reason: string): string {
  return CREDIT_REASON_LABELS[reason as CreditReason] ?? reason.replace(/_/g, ' ').toLowerCase();
}

export default function CreditsPage() {
  const [info, setInfo] = useState<CreditsInfo | null>(null);
  const [tab, setTab] = useState<TabKey>('all');
  const [page, setPage] = useState(1);
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [buying, setBuying] = useState<CreditPurchaseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // The "expiring" tab reuses the earned feed and filters client-side, so the
  // query only ever sends the three server-supported types.
  const queryType = tab === 'expiring' ? 'earned' : tab;

  const load = useCallback(() => {
    api<CreditsInfo>(`/api/credits?page=${page}&limit=${PAGE_SIZE}&type=${queryType}`, {
      auth: true,
    })
      .then(setInfo)
      .catch(() => setError('Could not load your credits'));
  }, [page, queryType]);

  useEffect(load, [load]);
  useEffect(() => {
    api<CreditPackage[]>('/api/credits/packages', { auth: true })
      .then(setPackages)
      .catch(() => {});
  }, []);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }

  async function startPurchase(pack: CreditPackage) {
    setError('');
    setBusy(true);
    try {
      setBuying(
        await api<CreditPurchaseResult>('/api/credits/purchase', {
          body: { packageId: pack.id },
          auth: true,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not start the purchase');
    } finally {
      setBusy(false);
    }
  }

  async function settle(outcome: 'success' | 'failure') {
    if (!buying) return;
    setBusy(true);
    try {
      const result = await api<{ status: string; credits: number }>(
        `/api/credits/purchase/${buying.purchaseId}/mock-pay`,
        { body: { outcome }, auth: true },
      );
      setBuying(null);
      if (result.status === 'PAID') {
        flash(`${result.credits} credits added to your wallet`);
        setPage(1);
        load();
      } else {
        setError('Payment failed — no credits were added.');
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not complete the payment');
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-28 rounded-2xl bg-cream-100" />
        <div className="h-96 rounded-2xl bg-cream-100" />
      </div>
    );
  }

  const rows =
    tab === 'expiring' ? info.ledger.filter((row) => row.expiresAt !== null) : info.ledger;
  const totalPages = Math.max(1, Math.ceil(info.ledgerTotal / PAGE_SIZE));
  const firstRow = (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(page * PAGE_SIZE, info.ledgerTotal);
  const rupeesPerCredit = info.creditValuePaise / 100;

  const EARN_WAYS = [
    {
      Icon: BoxIcon,
      title: 'Shop on Clowe',
      text: `1 credit for every ₹${info.earnPaisePerCredit / 100} you pay`,
      href: '/products',
    },
    {
      Icon: TagIcon,
      title: 'Refer & Earn',
      text: 'Earn 100 credits when a friend orders',
      href: '/referrals',
    },
    {
      Icon: CheckIcon,
      title: 'Buy credits',
      text: 'Top up and get bonus credits on bigger packs',
      href: '#packages',
    },
    {
      Icon: ReturnIcon,
      title: 'Cancelled orders',
      text: 'Credits you spent come straight back',
      href: '/orders',
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <Link href="/account" className="hover:text-brand-600">
          My Account
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Clowe Credits</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title text-ink-900">Clowe Credits &amp; Wallet</h1>
          <p className="t-section-desc mt-1 text-gray-500">
            Use your credits to save more on every order.
          </p>
        </div>
        <a
          href="#packages"
          className="t-btn rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800"
        >
          🪙 Buy Clowe Credits
        </a>
      </div>

      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {/* Balance */}
          <section className="grid gap-5 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <div>
              <p className="t-card-label text-gray-600">Clowe Credits Balance</p>
              <p className="mt-1 flex items-center gap-2">
                <span className="font-display text-5xl font-bold text-ink-900">{info.balance}</span>
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-lg text-brand-700">
                  🪙
                </span>
              </p>
              <p className="t-caption mt-1 text-gray-500">
                {formatPaise(info.valuePaise)} value
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-3 sm:border-l sm:border-gray-100 sm:pl-5">
              {[
                { label: 'Total Earned', value: info.totalEarned, icon: '📥' },
                { label: 'Total Used', value: info.totalUsed, icon: '📤' },
                { label: 'Expiring Soon', value: info.expiringIn90Days, icon: '⏳' },
              ].map((stat) => (
                <div key={stat.label} className="flex items-start gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-100">
                    {stat.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="t-caption text-gray-500">{stat.label}</p>
                    <p className="t-kpi text-ink-900">{stat.value.toLocaleString('en-IN')}</p>
                  </div>
                </div>
              ))}
              {info.nextExpiryAt && (
                <p className="t-caption text-gray-500 sm:col-span-3">
                  Next batch lapses on{' '}
                  <span className="font-semibold text-ink-900">{fmtDate(info.nextExpiryAt)}</span> ·
                  credits are valid for {info.expiryMonths} months
                </p>
              )}
            </div>
          </section>

          {/* Ledger */}
          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="scrollbar-none flex gap-1 overflow-x-auto border-b border-gray-100 px-2">
              {TABS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    setTab(item.key);
                    setPage(1);
                  }}
                  className={`t-nav shrink-0 border-b-2 px-4 py-3.5 transition ${
                    tab === item.key
                      ? 'border-brand-600 text-brand-600'
                      : 'border-transparent text-gray-600 hover:text-ink-900'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto">
              {rows.length === 0 ? (
                <p className="px-5 py-12 text-center text-sm text-gray-500">
                  {tab === 'expiring'
                    ? 'No credits are close to expiring.'
                    : 'No transactions yet.'}
                </p>
              ) : (
                <table className="w-full min-w-[36rem]">
                  <thead>
                    <tr className="border-b border-gray-100 bg-cream-50 text-left">
                      {['Date', 'Description', 'Type', 'Credits', tab === 'expiring' ? 'Expires' : 'Status'].map(
                        (head) => (
                          <th key={head} className="t-table-head px-5 py-3 text-gray-500">
                            {head}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className="t-table-cell px-5 py-3.5 align-top text-ink-900">
                          {fmtDate(row.createdAt)}
                          <span className="t-caption block text-gray-400">
                            {fmtTime(row.createdAt)}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 align-top">
                          <span className="flex items-start gap-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cream-100">
                              {REASON_ICON[row.reason] ?? '🪙'}
                            </span>
                            <span className="min-w-0">
                              <span className="t-table-cell block font-semibold text-ink-900">
                                {row.orderNumber
                                  ? `Order #${row.orderNumber}`
                                  : reasonLabel(row.reason)}
                              </span>
                              <span className="t-caption block text-gray-500">
                                {row.orderNumber ? reasonLabel(row.reason) : 'Clowe Wallet'}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="t-table-cell px-5 py-3.5 align-top text-gray-600">
                          {row.delta > 0 ? 'Earned' : 'Used'}
                        </td>
                        <td
                          className={`t-table-head px-5 py-3.5 align-top ${
                            row.delta > 0 ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {row.delta > 0 ? `+${row.delta}` : row.delta}
                        </td>
                        <td className="px-5 py-3.5 align-top">
                          {tab === 'expiring' ? (
                            <span className="t-table-cell text-gray-600">
                              {row.expiresAt ? fmtDate(row.expiresAt) : '—'}
                            </span>
                          ) : (
                            <span className="t-badge rounded-full bg-green-50 px-2.5 py-1 text-green-700">
                              Completed
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {info.ledgerTotal > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3.5">
                <p className="t-caption text-gray-500">
                  Showing {firstRow} to {lastRow} of {info.ledgerTotal} transactions
                </p>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    aria-label="Previous page"
                    className="h-8 w-8 rounded-lg border border-gray-300 disabled:opacity-40"
                  >
                    ‹
                  </button>
                  {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      onClick={() => setPage(n)}
                      className={`t-table-head h-8 w-8 rounded-lg border ${
                        n === page
                          ? 'border-ink-900 bg-ink-900 text-white'
                          : 'border-gray-300 text-ink-900'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    aria-label="Next page"
                    className="h-8 w-8 rounded-lg border border-gray-300 disabled:opacity-40"
                  >
                    ›
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Packages */}
          <section id="packages" className="rounded-2xl border border-gray-100 bg-white p-5">
            <h2 className="t-sub-heading text-ink-900">Buy Clowe Credits</h2>
            <p className="t-caption mt-1 text-gray-500">
              Credits never lose value — 1 credit = ₹{rupeesPerCredit.toFixed(2)} at checkout, valid
              for {info.expiryMonths} months.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {packages.map((pack) => (
                <div
                  key={pack.id}
                  className={`rounded-xl border p-4 ${
                    pack.bonusCredits > 0 ? 'border-brand-600 bg-brand-50/40' : 'border-gray-200'
                  }`}
                >
                  {pack.bonusCredits > 0 && (
                    <span className="t-badge rounded bg-brand-600 px-2 py-0.5 text-white">
                      +{pack.bonusCredits} bonus
                    </span>
                  )}
                  <p className="t-kpi mt-2 text-ink-900">
                    {(pack.credits + pack.bonusCredits).toLocaleString('en-IN')}
                  </p>
                  <p className="t-caption text-gray-500">credits</p>
                  <p className="t-card-label mt-2 text-ink-900">{formatPaise(pack.pricePaise)}</p>
                  <button
                    onClick={() => void startPurchase(pack)}
                    disabled={busy}
                    className="t-btn mt-3 w-full rounded-lg bg-ink-900 py-2.5 text-white transition hover:bg-ink-800 disabled:opacity-50"
                  >
                    Buy now
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ── Right rail ─────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Credits Summary</h2>
            <dl className="mt-3 space-y-2.5">
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Clowe Credits Balance</dt>
                <dd className="t-card-label text-brand-700">🪙 {info.balance}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Credits Value</dt>
                <dd className="t-card-label text-ink-900">{formatPaise(info.valuePaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Expiring in 90 days</dt>
                <dd className="t-card-label text-brand-600">{info.expiringIn90Days}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="t-caption text-gray-600">Expiring in 30 days</dt>
                <dd className="t-card-label text-brand-600">{info.expiringIn30Days}</dd>
              </div>
            </dl>
            <a
              href="#packages"
              className="t-btn mt-4 block rounded-lg bg-ink-900 py-2.5 text-center text-white transition hover:bg-ink-800"
            >
              Buy Clowe Credits
            </a>
          </div>

          <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4">
            <div className="flex items-start gap-3">
              <span className="text-2xl">🪙</span>
              <div className="min-w-0">
                <p className="t-sub-heading text-ink-900">Use Credits, Save More!</p>
                <p className="t-caption mt-1 font-semibold text-ink-900">
                  1 Clowe Credit = ₹{rupeesPerCredit.toFixed(2)}
                </p>
                <p className="t-caption mt-1 text-gray-600">
                  Tick &ldquo;Use my Clowe Credits&rdquo; at checkout to get an instant discount.
                </p>
                <Link
                  href="/cart"
                  className="t-caption mt-2 inline-block font-semibold text-brand-600 hover:underline"
                >
                  Go to cart ›
                </Link>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">How to Earn More Credits</h2>
            <ul className="mt-3 divide-y divide-gray-100">
              {EARN_WAYS.map(({ Icon, title, text, href }) => (
                <li key={title}>
                  <Link href={href} className="flex items-start gap-2.5 py-3 hover:text-brand-600">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    <span className="min-w-0">
                      <span className="t-card-label block text-ink-900">{title}</span>
                      <span className="t-caption block text-gray-500">{text}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              href="/referrals"
              className="t-btn mt-2 block rounded-lg border border-gray-300 py-2.5 text-center text-ink-900 transition hover:border-brand-600"
            >
              View Refer &amp; Earn
            </Link>
          </div>

          <div className="flex items-start gap-2.5 rounded-2xl border border-gray-100 bg-white p-4">
            <ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            <p className="t-caption text-gray-600">
              Credits expire {info.expiryMonths} months after you earn them, and the oldest ones are
              always spent first.
            </p>
          </div>
        </aside>
      </div>

      {/* Trust strip */}
      <section className="grid gap-3 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-2 lg:grid-cols-5">
        {TRUST_STRIP.map(({ Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="t-caption font-bold text-ink-900">{title}</p>
              <p className="t-caption text-gray-500">{text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Mock gateway */}
      {buying && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center">
            <p className="t-caption uppercase tracking-widest text-gray-400">
              Mock Payment Gateway (dev)
            </p>
            <p className="t-kpi mt-3 text-ink-900">{formatPaise(buying.amountPaise)}</p>
            <p className="t-caption mt-1 text-gray-500">
              {buying.credits.toLocaleString('en-IN')} credits
              {buying.bonusCredits > 0 && ` + ${buying.bonusCredits} bonus`}
            </p>
            <p className="t-caption mt-2 text-gray-400">
              In production this is the Razorpay window.
            </p>
            <div className="mt-5 space-y-2">
              <button
                onClick={() => void settle('success')}
                disabled={busy}
                className="t-btn w-full rounded-lg bg-green-600 py-2.5 text-white hover:bg-green-700 disabled:opacity-50"
              >
                ✓ Simulate successful payment
              </button>
              <button
                onClick={() => void settle('failure')}
                disabled={busy}
                className="t-btn w-full rounded-lg border border-red-300 py-2.5 text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                ✕ Simulate failed payment
              </button>
              <button
                onClick={() => setBuying(null)}
                className="t-caption w-full py-1 text-gray-500 hover:text-ink-900"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
