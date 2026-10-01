/**
 * What the shopper-facing coupon surfaces may show while coupons are switched
 * off platform-wide (PlatformSettings.couponsEnabled).
 *
 * These decisions used to live inline in the components, and one of them was
 * placed inside the wrong branch: the cart's coupon row hid the "X applied"
 * box when coupons were off — a state that cannot occur, because the API
 * drops any stored code — and left the "Add Coupon" entry point, the state
 * that always occurs, ungated. Production showed every shopper a button to a
 * feature that was off.
 *
 * `null` means the setting has not loaded yet, and counts as off: nothing is
 * offered until it is known that it can be honoured.
 */

export type CouponPanelSurface = 'hidden' | 'applied' | 'entry';

/** The cart's coupon row: nothing, the applied code, or the way in. */
export function couponPanelSurface(
  couponsEnabled: boolean | null,
  hasApplied: boolean,
): CouponPanelSurface {
  if (couponsEnabled !== true) return 'hidden';
  return hasApplied ? 'applied' : 'entry';
}

/** Help content that only makes sense while coupons are on, filtered out otherwise. */
export function faqEntriesFor<T extends { needsCoupons?: boolean }>(
  entries: readonly T[],
  couponsEnabled: boolean | null,
): T[] {
  return entries.filter((e) => !e.needsCoupons || couponsEnabled === true);
}
