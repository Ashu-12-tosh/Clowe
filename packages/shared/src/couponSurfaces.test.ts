import { describe, expect, it } from 'vitest';
import { couponPanelSurface, faqEntriesFor } from './couponSurfaces';

describe('couponPanelSurface', () => {
  it('shows no entry point while coupons are off', () => {
    // The production bug: coupons off, nothing applied, and the cart still
    // showed "Coupon Discount — Add Coupon".
    expect(couponPanelSurface(false, false)).toBe('hidden');
  });

  it('shows nothing until the setting is known', () => {
    expect(couponPanelSurface(null, false)).toBe('hidden');
    expect(couponPanelSurface(null, true)).toBe('hidden');
  });

  it('hides an applied code too while coupons are off', () => {
    // Cannot normally occur — the API drops stored codes — but if it did, a
    // green "applied" box for a discount that will not be honoured is worse
    // than nothing.
    expect(couponPanelSurface(false, true)).toBe('hidden');
  });

  it('offers the way in only while coupons are on', () => {
    expect(couponPanelSurface(true, false)).toBe('entry');
    expect(couponPanelSurface(true, true)).toBe('applied');
  });
});

describe('faqEntriesFor', () => {
  const entries = [
    { id: 'returns' },
    { id: 'coupons', needsCoupons: true },
    { id: 'credits', needsCoupons: false },
  ];

  it('drops coupon-only help while coupons are off or unknown', () => {
    expect(faqEntriesFor(entries, false).map((e) => e.id)).toEqual(['returns', 'credits']);
    expect(faqEntriesFor(entries, null).map((e) => e.id)).toEqual(['returns', 'credits']);
  });

  it('keeps everything while coupons are on', () => {
    expect(faqEntriesFor(entries, true).map((e) => e.id)).toEqual(['returns', 'coupons', 'credits']);
  });
});
