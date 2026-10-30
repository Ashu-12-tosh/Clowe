'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { TrackCodeSent, TrackCodeVerified, TrackOrderView } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { OrderTracking, refreshNote } from '@/components/orders/TrackingBar';

// Track Order: the order number and the phone or email on the order, then the
// code sent there. Signed in, the buyer's own orders open without a code. The
// code's token lasts 30 minutes and is kept for this tab only.

const TOKEN_KEY = 'clowe.track';

function readToken(orderNumber: string): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as { orderNumber: string; token: string; until: number } | null;
    return saved && saved.orderNumber === orderNumber && saved.until > Date.now() ? saved.token : null;
  } catch {
    return null;
  }
}
function saveToken(orderNumber: string, v: TrackCodeVerified) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ orderNumber, token: v.token, until: Date.now() + v.expiresInSec * 1000 }));
  } catch {
    // Private mode: the page still works until it is reloaded.
  }
}

function TrackPageInner() {
  const params = useSearchParams();
  const [orderNumber, setOrderNumber] = useState((params.get('orderNumber') ?? '').toUpperCase());
  const [contact, setContact] = useState('');
  const [sent, setSent] = useState<TrackCodeSent | null>(null);
  const [code, setCode] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<(TrackOrderView & { orderId?: string }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const [signedIn, setSignedIn] = useState(false);

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiRequestError ? err.message : fallback);

  const openWithToken = useCallback(async (t: string) => {
    setData(await api<TrackOrderView>('/api/track/view', { headers: { 'x-track-token': t }, quiet: true }));
    setToken(t);
  }, []);

  // Back on the page in the same tab: the code's token is still good.
  useEffect(() => {
    setSignedIn(!!getStoredUser());
    const n = (params.get('orderNumber') ?? '').toUpperCase();
    const t = n ? readToken(n) : null;
    if (t) openWithToken(t).catch(() => {});
  }, [params, openWithToken]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setData(null);
    setBusy(true);
    const number = orderNumber.trim();
    try {
      // Signed in and it's theirs: no code needed.
      if (getStoredUser()) {
        try {
          setData(await api<TrackOrderView & { orderId: string }>(`/api/track/mine?orderNumber=${encodeURIComponent(number)}`, { auth: true, quiet: true }));
          return;
        } catch {
          // Not their order (or signed out): fall through to the code.
        }
      }
      if (!contact.trim()) {
        setError('Enter the phone number or email on the order');
        return;
      }
      setSent(await api<TrackCodeSent>('/api/track/request-code', { body: { orderNumber: number, contact: contact.trim() }, quiet: true }));
      setCode('');
    } catch (err) {
      fail(err, 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const number = orderNumber.trim().toUpperCase();
    try {
      const v = await api<TrackCodeVerified>('/api/track/verify', { body: { orderNumber: number, contact: contact.trim(), code: code.trim() }, quiet: true });
      saveToken(number, v);
      await openWithToken(v.token);
      setSent(null);
    } catch (err) {
      fail(err, 'Could not check the code');
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!data) return;
    setRefreshing(true);
    setNote('');
    try {
      if (data.orderId) {
        const r = await api<{ asked: number; cached: number; nextRefreshAt: string | null; tracking: TrackOrderView['parcels'] }>(
          `/api/orders/${data.orderId}/tracking/refresh`,
          { method: 'POST', auth: true, quiet: true },
        );
        setData({ ...data, parcels: r.tracking });
        setNote(refreshNote(r));
      } else if (token) {
        const r = await api<{ asked: number; cached: number; nextRefreshAt: string | null; view: TrackOrderView }>('/api/track/refresh', {
          method: 'POST',
          headers: { 'x-track-token': token },
          quiet: true,
        });
        setData(r.view);
        setNote(refreshNote(r));
      }
    } catch (err) {
      setNote(err instanceof ApiRequestError ? err.message : 'Could not check with the courier — try again in a minute.');
    } finally {
      setRefreshing(false);
    }
  }

  const inputClass = 'w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600';

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold">Track your order</h1>
      <p className="mt-1 text-sm text-gray-600">
        Enter your order number and the phone number or email on the order. We&apos;ll send a one-time code there, so only you can see it.
        {signedIn && (
          <>
            {' '}
            Signed in? Your own orders open straight away — or see them all in{' '}
            <Link href="/orders" className="font-semibold text-brand-600 hover:underline">
              My Orders
            </Link>
            .
          </>
        )}
      </p>

      {!sent && (
        <form onSubmit={(e) => void start(e)} className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" data-track-form>
          <label className="block">
            <span className="sr-only">Order number</span>
            <input
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value.toUpperCase())}
              placeholder="Order number (e.g. CLW-7KQ3MX9P2T)"
              autoComplete="off"
              className={inputClass}
              name="orderNumber"
            />
          </label>
          <label className="block">
            <span className="sr-only">Phone or email on the order</span>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Phone or email on the order"
              inputMode="email"
              autoComplete="email"
              className={inputClass}
              name="contact"
            />
          </label>
          <button
            disabled={busy || !orderNumber.trim()}
            className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Track'}
          </button>
        </form>
      )}

      {sent && (
        <form onSubmit={(e) => void verify(e)} className="mt-4 rounded-xl border border-gray-200 bg-white p-4" data-track-code-form>
          <p className="text-sm text-gray-700">
            We sent a 6-digit code {sent.channel === 'sms' ? 'by SMS to' : 'by email to'} <span className="font-semibold">{sent.sentTo}</span>.
            {sent.devOtp && <span className="ml-1 text-xs text-gray-400">(test code: {sent.devOtp})</span>}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <label className="block sm:w-48">
              <span className="sr-only">6-digit code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                className={`${inputClass} tracking-widest`}
                name="code"
                autoFocus
              />
            </label>
            <button
              disabled={busy || code.length !== 6}
              className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Show my order'}
            </button>
            <button type="button" onClick={() => setSent(null)} className="text-sm font-semibold text-gray-600 hover:text-brand-600">
              Change details
            </button>
          </div>
        </form>
      )}

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {data && (
        <div className="mt-6" data-track-result>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="break-all text-lg font-bold">{data.orderNumber}</p>
              <p className="text-xs text-gray-500">
                Placed {new Date(data.placedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })} · Delivering to{' '}
                {data.shipCity}, {data.shipState} — {data.shipPincode}
              </p>
            </div>
            {!data.paid && data.status !== 'CANCELLED' && (
              <span className="rounded-full bg-yellow-100 px-3 py-1 text-xs font-semibold text-yellow-800">Payment pending</span>
            )}
          </div>
          <div className="mt-4">
            <OrderTracking parcels={data.parcels} onRefresh={() => void refresh()} refreshing={refreshing} note={note} />
          </div>
          {data.orderId && (
            <Link href={`/account/orders/${data.orderId}`} className="mt-4 inline-block text-sm font-semibold text-brand-600 hover:underline">
              See the full order →
            </Link>
          )}
        </div>
      )}
    </main>
  );
}

export default function TrackPage() {
  return (
    <Suspense>
      <TrackPageInner />
    </Suspense>
  );
}
