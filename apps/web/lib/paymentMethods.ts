'use client';

import { useEffect, useState } from 'react';
import { getPublicSettings, onPublicSettingsChanged } from '@/lib/settings';

/** How customers can pay online, by method — not card or wallet brands, which depend on the gateway. */
export const ONLINE_PAYMENT_METHODS = ['UPI', 'Cards', 'Net banking'] as const;

/**
 * The payment methods a page may name: the online ones, plus Cash on Delivery
 * only once settings say it is switched on for Clowe (PlatformSettings.codEnabled).
 * Until they load, COD is left out, so no first paint promises it.
 */
export function usePaymentMethodNames(): string[] {
  const [codEnabled, setCodEnabled] = useState(false);
  useEffect(() => {
    const load = () =>
      getPublicSettings()
        .then((s) => setCodEnabled(s.codEnabled === true))
        .catch(() => {});
    load();
    return onPublicSettingsChanged(load);
  }, []);
  return codEnabled ? [...ONLINE_PAYMENT_METHODS, 'Cash on Delivery'] : [...ONLINE_PAYMENT_METHODS];
}
