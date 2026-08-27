'use client';

import { useEffect, useState } from 'react';
import type { AppliedCoupon, CartView, CouponOffer } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { TagIcon } from './CartIcons';

interface Props {
  applied: AppliedCoupon | null;
  subtotalPaise: number;
  /** Called with the recomputed cart after a coupon is applied or removed. */
  onCartChange: (cart: CartView) => void;
}

/** What a coupon takes off, in words — e.g. "10% off up to ₹300". */
function offerHeadline(offer: CouponOffer): string {
  if (offer.type === 'FLAT') return `${formatPaise(offer.value)} OFF`;
  return offer.maxDiscountPaise
    ? `${offer.value}% OFF up to ${formatPaise(offer.maxDiscountPaise)}`
    : `${offer.value}% OFF`;
}

/**
 * The "Coupon Discount" row of the order summary: applied state with a
 * remove action, or a code box plus the live list of usable offers.
 */
export default function CouponPanel({ applied, subtotalPaise, onCartChange }: Props) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [offers, setOffers] = useState<CouponOffer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Offers load once the panel is first opened — nothing to fetch until then.
  useEffect(() => {
    if (!open || offers.length > 0) return;
    api<CouponOffer[]>('/api/cart/coupons', { auth: true })
      .then(setOffers)
      .catch(() => {});
  }, [open, offers.length]);

  async function apply(raw: string) {
    const trimmed = raw.trim();
    if (trimmed.length < 3) {
      setError('Enter a coupon code');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const cart = await api<CartView>('/api/cart/coupon', {
        method: 'POST',
        body: { code: trimmed },
        auth: true,
      });
      onCartChange(cart);
      setCode('');
      setOpen(false);
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

  if (applied) {
    return (
      <div className="rounded-xl border border-dashed border-green-300 bg-green-50 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <TagIcon className="h-4 w-4 shrink-0 text-green-700" />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-green-800">{applied.code} applied</p>
              {applied.description && (
                <p className="truncate text-xs text-green-700">{applied.description}</p>
              )}
            </div>
          </div>
          <button
            onClick={() => void remove()}
            disabled={busy}
            className="shrink-0 text-xs font-semibold text-gray-500 underline hover:text-red-600 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-600">Coupon Discount</span>
        <button
          onClick={() => setOpen((v) => !v)}
          className="font-semibold text-brand-600 hover:underline"
        >
          {open ? 'Close' : 'Add Coupon'}
        </button>
      </div>

      {open && (
        <div className="mt-2.5 rounded-xl border border-gray-200 bg-cream-50 p-3">
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && void apply(code)}
              placeholder="Enter coupon code"
              aria-label="Coupon code"
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm uppercase tracking-wide outline-none focus:border-brand-600"
            />
            <button
              onClick={() => void apply(code)}
              disabled={busy}
              className="rounded-lg bg-ink-900 px-4 text-xs font-bold uppercase tracking-wide text-white transition hover:bg-ink-800 disabled:opacity-50"
            >
              {busy ? '…' : 'Apply'}
            </button>
          </div>
          {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}

          {offers.length > 0 && (
            <ul className="mt-3 space-y-2">
              {offers.map((offer) => {
                const short = offer.minSubtotalPaise - subtotalPaise;
                const eligible = short <= 0;
                return (
                  <li
                    key={offer.code}
                    className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-gray-300 bg-white px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-bold tracking-wide text-ink-900">
                        {offer.code}
                        <span className="ml-2 font-semibold text-brand-600">
                          {offerHeadline(offer)}
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-gray-500">
                        {eligible
                          ? (offer.description ?? 'Applies to your current cart')
                          : `Add ${formatPaise(short)} more to use this`}
                      </p>
                    </div>
                    <button
                      onClick={() => void apply(offer.code)}
                      disabled={busy || !eligible}
                      className="shrink-0 text-xs font-bold uppercase tracking-wide text-brand-600 hover:underline disabled:text-gray-400 disabled:no-underline"
                    >
                      Apply
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
