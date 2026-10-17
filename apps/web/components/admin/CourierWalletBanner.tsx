'use client';

import { useEffect, useState } from 'react';
import type { CourierWalletAlert } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { ExternalLink } from '@/components/ExternalLink';

/**
 * On every admin page while Delhivery is refusing bookings over Clowe's
 * wallet (too low, or locked). Delhivery has no API for the balance, so the
 * refusal is the signal; an admin recharges, then marks it resolved.
 */
export default function CourierWalletBanner() {
  const [alert, setAlert] = useState<CourierWalletAlert | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<CourierWalletAlert | null>('/api/admin/shipments/wallet-alert', { auth: true })
      .then(setAlert)
      .catch(() => setAlert(null));
  }, []);

  if (!alert) return null;

  async function resolve() {
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/shipments/wallet-alert', { method: 'DELETE', auth: true, success: 'Wallet alert resolved' });
      setAlert(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not resolve it');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto mb-4 max-w-6xl rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900" role="alert" data-wallet-alert>
      <p className="text-sm font-bold">Delhivery is refusing bookings — recharge the wallet</p>
      <p className="mt-1">
        Delhivery said: &ldquo;{alert.message}&rdquo;{alert.context ? ` (${alert.context})` : ''}. {alert.count} refusal
        {alert.count === 1 ? '' : 's'} since {new Date(alert.firstAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.
      </p>
      <p className="mt-1">
        <strong>Recharge wallet:</strong> Delhivery One → Finances → Wallet → Recharge Wallet, and keep at least ₹500 in it. If it is locked
        (negative beyond its limit), recharge enough to bring it back above zero. Sellers can book again once it is recharged.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ExternalLink href="https://one.delhivery.com" className="rounded-lg bg-red-700 px-3 py-1 font-semibold text-white hover:bg-red-800">
          Open Delhivery One
        </ExternalLink>
        <button
          type="button"
          disabled={busy}
          onClick={() => void resolve()}
          className="rounded-lg border border-red-300 bg-white px-3 py-1 font-semibold hover:bg-red-100 disabled:opacity-50"
        >
          {busy && <Spinner className="mr-1" />}
          Recharged — mark resolved
        </button>
      </div>
      {error && <p className="mt-1 text-red-700">{error}</p>}
    </section>
  );
}
