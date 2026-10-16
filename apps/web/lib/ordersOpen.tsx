'use client';

import { useEffect, useState } from 'react';
import { STORE_CLOSED_MESSAGE } from '@clowe/shared';
import { api, getStoredUser } from './api';
import { getPublicSettings } from './settings';

/**
 * Can this visitor place an order now? True once the admin opens the store;
 * until then only admins and test accounts can (the API says which). Null
 * while it is being worked out.
 */
export function useOrdersOpen(): boolean | null {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getPublicSettings()
      .then(async (s) => {
        if (s.storeOpenForOrders) return true;
        if (!getStoredUser()) return false;
        return (await api<{ open: boolean }>('/api/orders/availability', { auth: true })).open;
      })
      .then((v) => live && setOpen(v))
      .catch(() => live && setOpen(true)); // the API still decides; never block on a failed read
    return () => {
      live = false;
    };
  }, []);
  return open;
}

/** "We're launching soon — orders open shortly." */
export function LaunchingSoon({ className = '' }: { className?: string }) {
  return (
    <p className={`rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-center text-sm font-semibold text-amber-900 ${className}`} role="status" data-store-closed>
      {STORE_CLOSED_MESSAGE}
    </p>
  );
}
