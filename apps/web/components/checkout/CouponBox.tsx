'use client';

import { useEffect, useState } from 'react';
import type { AppliedCoupon, CartView, CouponOffer } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { TagIcon } from '@/components/cart/CartIcons';

interface Props {
  applied: AppliedCoupon | null;
  subtotalPaise: number;
  onCartChange: (cart: CartView) => void;
}

function offerHeadline(offer: CouponOffer): string {
  if (offer.type === 'FLAT') return `${formatPaise(offer.value)} OFF`;
  return offer.maxDiscountPaise
    ? `${offer.value}% OFF up to ${formatPaise(offer.maxDiscountPaise)}`
    : `${offer.value}% OFF`;
}

/** Step 4 of checkout: apply a code, or pick one from the live offer list. */
export default function CouponBox({ applied, subtotalPaise, onCartChange }: Props) {
  const [code, setCode] = useState('');
  const [offers, setOffers] = useState<CouponOffer[]>([]);
  const [showOffers, setShowOffers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!showOffers || offers.length > 0) return;
    api<CouponOffer[]>('/api/cart/coupons', { auth: true })
      .then(setOffers)
      .catch(() => {});
  }, [showOffers, offers.length]);

  async function apply(raw: string) {
    const trimmed = raw.trim();
    if (trimmed.length < 3) {
      setError('Enter a coupon code');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onCartChange(
        await api<CartView>('/api/cart/coupon', {
          method: 'POST',
          body: { code: trimmed },
          auth: true,
        }),
      );
      setCode('');
      setShowOffers(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not apply that coupon');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError('');
    try {
      onCartChange(await api<CartView>('/api/cart/coupon', { method: 'DELETE', auth: true }));
    } catch {
      setError('Could not remove the coupon');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && void apply(code)}
          placeholder="Enter coupon code"
          aria-label="Coupon code"
          disabled={busy}
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm uppercase tracking-wide outline-none focus:border-brand-600"
        />
        <button
          onClick={() => void apply(code)}
          disabled={busy}
          className="rounded-lg bg-ink-900 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-ink-800 disabled:opacity-50"
        >
          {busy ? '…' : 'Apply'}
        </button>
        <button
          onClick={() => setShowOffers((v) => !v)}
          className="shrink-0 text-sm font-semibold text-brand-600 hover:underline sm:ml-2"
        >
          {showOffers ? 'Hide coupons' : 'View all coupons'}
        </button>
      </div>

      {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}

      {applied && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-dashed border-green-300 bg-green-50 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-green-800">
            <TagIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{applied.code} applied</span>
          </span>
          <span className="flex shrink-0 items-center gap-3">
            <span className="text-sm font-bold text-green-700">
              You saved {formatPaise(applied.discountPaise)}
            </span>
            <button
              onClick={() => void remove()}
              disabled={busy}
              className="text-xs font-semibold text-gray-500 underline hover:text-red-600 disabled:opacity-50"
            >
              Remove
            </button>
          </span>
        </div>
      )}

      {showOffers && (
        <ul className="mt-3 space-y-2">
          {offers.map((offer) => {
            const short = offer.minSubtotalPaise - subtotalPaise;
            const eligible = short <= 0;
            return (
              <li
                key={offer.code}
                className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-gray-300 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-xs font-bold tracking-wide text-ink-900">
                    {offer.code}
                    <span className="ml-2 font-semibold text-brand-600">{offerHeadline(offer)}</span>
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-gray-500">
                    {eligible
                      ? (offer.description ?? 'Applies to your current order')
                      : `Add ${formatPaise(short)} more to use this`}
                  </p>
                </div>
                <button
                  onClick={() => void apply(offer.code)}
                  disabled={busy || !eligible || applied?.code === offer.code}
                  className="shrink-0 text-xs font-bold uppercase tracking-wide text-brand-600 hover:underline disabled:text-gray-400 disabled:no-underline"
                >
                  {applied?.code === offer.code ? 'Applied' : 'Apply'}
                </button>
              </li>
            );
          })}
          {offers.length === 0 && (
            <li className="text-xs text-gray-500">No coupons available right now.</li>
          )}
        </ul>
      )}
    </div>
  );
}
