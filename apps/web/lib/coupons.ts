'use client';

import { useEffect, useState } from 'react';
import { getPublicSettings } from './settings';

/**
 * Whether coupons are offered to shoppers right now.
 *
 * Every coupon surface in the web app asks this one question, so turning the
 * feature on or off is a single platform setting rather than a hunt through
 * the components that happen to mention a coupon.
 *
 * Starts as `null` — unknown, not "off" — so a surface can render nothing at
 * all until the answer arrives instead of flashing a coupon box that is about
 * to disappear. The server refuses coupon requests independently, so a wrong
 * guess here would be untidy rather than exploitable.
 */
export function useCouponsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    getPublicSettings()
      .then((s) => alive && setEnabled(s.couponsEnabled))
      // Fail closed: if settings cannot be read, do not offer a coupon box
      // whose submit the server is going to refuse anyway.
      .catch(() => alive && setEnabled(false));
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}
