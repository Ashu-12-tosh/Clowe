'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CouponOffer, PdpOffer } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { TagIcon } from '@/components/cart/CartIcons';

interface Props {
  /** Selected variant price — the coupon maths is done against it. */
  pricePaise: number;
  /** Bank/EMI offers from platform settings. */
  offers: PdpOffer[];
}

/** What a coupon takes off this price, honouring its cap and minimum. */
function discountFor(coupon: CouponOffer, pricePaise: number): number {
  if (pricePaise < coupon.minSubtotalPaise) return 0;
  const raw =
    coupon.type === 'FLAT' ? coupon.value : Math.floor((pricePaise * coupon.value) / 100);
  const capped = coupon.maxDiscountPaise ? Math.min(raw, coupon.maxDiscountPaise) : raw;
  return Math.max(0, Math.min(capped, pricePaise));
}

/**
 * "Get it for ₹X" strip plus the offers list. The headline price comes from a
 * real coupon the shopper can apply in the cart — nothing here is decorative.
 */
export default function OffersCard({ pricePaise, offers }: Props) {
  const [coupons, setCoupons] = useState<CouponOffer[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Public list; logged-out shoppers still see what's available.
    api<CouponOffer[]>('/api/cart/coupons', { auth: true })
      .then(setCoupons)
      .catch(() => setCoupons([]));
  }, []);

  const best = coupons
    .map((coupon) => ({ coupon, discountPaise: discountFor(coupon, pricePaise) }))
    .filter((row) => row.discountPaise > 0)
    .sort((a, b) => b.discountPaise - a.discountPaise)[0];

  const totalOffers = offers.length + coupons.length;

  return (
    <div className="mt-4">
      {best && (
        <Link
          href="/cart"
          className="flex items-center gap-3 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 transition hover:border-brand-600"
        >
          <TagIcon className="h-5 w-5 shrink-0 text-brand-600" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-ink-900">
              Get it for {formatPaise(pricePaise - best.discountPaise)}
            </span>
            <span className="block text-xs text-gray-600">
              Extra {formatPaise(best.discountPaise)} off with code{' '}
              <span className="font-bold text-brand-700">{best.coupon.code}</span> — apply in cart
            </span>
          </span>
          <span className="text-gray-400">›</span>
        </Link>
      )}

      {totalOffers > 0 && (
        <div className="mt-4">
          <p className="text-sm font-bold text-ink-900">Offers</p>
          <ul className="mt-2 space-y-2">
            {offers.slice(0, expanded ? offers.length : 2).map((offer) => (
              <li key={offer.label} className="flex gap-2 text-sm">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-300" />
                <span className="min-w-0">
                  <span className="font-semibold text-ink-900">{offer.label}</span>{' '}
                  <span className="text-gray-600">{offer.text}.</span>
                  {expanded && offer.terms && (
                    <span className="block text-xs text-gray-400">{offer.terms}</span>
                  )}
                </span>
              </li>
            ))}

            {expanded &&
              coupons.map((coupon) => {
                const discount = discountFor(coupon, pricePaise);
                return (
                  <li key={coupon.code} className="flex gap-2 text-sm">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                    <span className="min-w-0">
                      <span className="font-semibold text-ink-900">Coupon {coupon.code}</span>{' '}
                      <span className="text-gray-600">
                        {coupon.description ?? 'Apply at cart'}.
                      </span>
                      <span className="block text-xs text-gray-400">
                        {discount > 0
                          ? `Saves ${formatPaise(discount)} on this item`
                          : `Needs a cart of ${formatPaise(coupon.minSubtotalPaise)} or more`}
                      </span>
                    </span>
                  </li>
                );
              })}
          </ul>

          {totalOffers > 2 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 text-sm font-semibold text-brand-600 hover:underline"
            >
              {expanded ? 'Show less' : `View All Offers (${totalOffers})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
