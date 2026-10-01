'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  PROMOTION_CREDIT_MIN_PAISE,
  type PromotionCreditPurchaseResult,
  type PromotionCreditSettleResult,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { LedgerPanel } from '@/components/seller/payouts/LedgerPanel';

const QUICK_RUPEES = [500, 1000, 2500, 5000];

/**
 * The promotion balance: what a seller has prepaid for placements, with a
 * top-up box and the PROMOTION side of their ledger underneath. The dev
 * gateway settles via mock-pay; with Razorpay the same purchase would open
 * the checkout widget and finish through /verify.
 */
export default function PromotionCreditsCard() {
  const [balance, setBalance] = useState<number | null>(null);
  const [rupees, setRupees] = useState('1000');
  const [pending, setPending] = useState<PromotionCreditPurchaseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await api<{ balancePaise: number }>('/api/seller/promotion-credits', { auth: true });
      setBalance(data.balancePaise);
    } catch {
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  async function start() {
    setError('');
    setNotice('');
    const amountPaise = Math.round(Number(rupees) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < PROMOTION_CREDIT_MIN_PAISE) {
      setError(`Minimum top-up is ${formatPaise(PROMOTION_CREDIT_MIN_PAISE)}`);
      return;
    }
    setBusy(true);
    try {
      setPending(
        await api<PromotionCreditPurchaseResult>('/api/seller/promotion-credits/purchase', {
          body: { amountPaise },
          auth: true,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not start the top-up');
    } finally {
      setBusy(false);
    }
  }

  async function settle(outcome: 'success' | 'failure') {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await api<PromotionCreditSettleResult>(
        `/api/seller/promotion-credits/purchase/${pending.purchaseId}/mock-pay`,
        { body: { outcome }, auth: true },
      );
      setPending(null);
      if (result.status === 'PAID') {
        setNotice(`${formatPaise(pending.amountPaise)} added to your promotion balance`);
        setRefresh((n) => n + 1);
      } else {
        setError('Payment failed — nothing was added.');
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not complete the payment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-ink-900">Promotion balance</h2>
            <p className="text-[11px] text-gray-400">
              Prepaid credits for ad placements. Spent when you book an ad, returned if it is
              declined, never paid out.
            </p>
            <p className="mt-2 font-display text-2xl font-bold text-ink-900">
              {balance === null ? '—' : formatPaise(balance)}
            </p>
          </div>
          <Link
            href="/seller/ads/new"
            className="rounded-lg border border-brand-600 px-4 py-2 text-xs font-bold text-brand-600 hover:bg-cream-50"
          >
            Book a placement
          </Link>
        </div>

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        {notice && (
          <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800">{notice}</p>
        )}

        {!pending ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="flex gap-1">
              {QUICK_RUPEES.map((r) => (
                <button
                  key={r}
                  onClick={() => setRupees(String(r))}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${
                    rupees === String(r) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-gray-300'
                  }`}
                >
                  ₹{r.toLocaleString('en-IN')}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={PROMOTION_CREDIT_MIN_PAISE / 100}
              value={rupees}
              onChange={(e) => setRupees(e.target.value)}
              className="w-28 rounded-lg border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-brand-600"
              aria-label="Top-up amount in rupees"
            />
            <button
              onClick={() => void start()}
              disabled={busy}
              className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Add credits'}
            </button>
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-gray-300 p-3 text-xs">
            <p className="font-semibold text-ink-900">
              Pay {formatPaise(pending.amountPaise)} via {pending.payment.provider}
            </p>
            <p className="mt-0.5 text-gray-500">
              Order {pending.payment.providerOrderId}. The dev gateway lets you choose the outcome.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void settle('success')}
                disabled={busy}
                className="rounded-lg bg-green-600 px-3 py-1.5 font-bold text-white hover:bg-green-700 disabled:opacity-50"
              >
                Pay now
              </button>
              <button
                onClick={() => void settle('failure')}
                disabled={busy}
                className="rounded-lg border border-gray-300 px-3 py-1.5 font-semibold hover:bg-gray-50 disabled:opacity-50"
              >
                Simulate failure
              </button>
            </div>
          </div>
        )}
      </section>

      <LedgerPanel
        bucket="PROMOTION"
        title="Promotion credits history"
        subtitle="Top-ups in, placements out."
        refreshKey={refresh}
        pageSize={10}
      />
    </div>
  );
}
