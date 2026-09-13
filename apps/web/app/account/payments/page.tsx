'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  savedPaymentMethodSchema,
  type PaymentMethodKind,
  type SavedPaymentMethodInfo,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { SUPPORT_CHAT_EVENT } from '@/components/SupportChat';
import {
  BoxIcon,
  CardIcon,
  HeadsetIcon,
  LockIcon,
  PlusIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns on eligible items' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

const SECTIONS: { kind: PaymentMethodKind; title: string; empty: string }[] = [
  { kind: 'CARD', title: 'Cards', empty: 'No cards saved yet.' },
  { kind: 'UPI', title: 'UPI Accounts', empty: 'No UPI IDs saved yet.' },
  { kind: 'WALLET', title: 'Wallets', empty: 'No wallets linked yet.' },
];

const PROVIDERS: Record<PaymentMethodKind, string[]> = {
  CARD: ['Visa', 'Mastercard', 'RuPay', 'Amex', 'Diners Club'],
  UPI: ['Google Pay', 'PhonePe', 'Paytm', 'BHIM', 'Amazon Pay'],
  WALLET: ['Paytm', 'Amazon Pay', 'PhonePe', 'Mobikwik', 'Freecharge'],
};

const KIND_LABEL: Record<PaymentMethodKind, string> = {
  CARD: 'Card',
  UPI: 'UPI ID',
  WALLET: 'Wallet',
};

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600';

/** Short brand mark — real logos are third-party trademarks we don't ship. */
function BrandMark({ brand }: { brand: string }) {
  return (
    <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white px-1 text-center text-[10px] font-bold uppercase tracking-wide text-ink-900">
      {brand}
    </span>
  );
}

export default function PaymentMethodsPage() {
  const [methods, setMethods] = useState<SavedPaymentMethodInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<PaymentMethodKind>('CARD');
  const [brand, setBrand] = useState(PROVIDERS.CARD[0]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const formRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    api<SavedPaymentMethodInfo[]>('/api/me/payment-methods', { auth: true })
      .then(setMethods)
      .catch(() => setMethods([]));
  }, []);

  useEffect(load, [load]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 3000);
  }

  function startAdd(next: PaymentMethodKind) {
    setKind(next);
    setBrand(PROVIDERS[next][0]);
    setAdding(true);
    setError('');
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    const parsed = savedPaymentMethodSchema.safeParse({
      kind,
      brand,
      label: String(form.get('label') ?? '').trim(),
      holderName: kind === 'CARD' ? String(form.get('holderName') ?? '').trim() || null : null,
      expiryMonth: kind === 'CARD' ? Number(form.get('expiryMonth')) || null : null,
      expiryYear: kind === 'CARD' ? Number(form.get('expiryYear')) || null : null,
      isDefault: form.get('isDefault') === 'on',
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      await api('/api/me/payment-methods', { body: parsed.data, auth: true });
      load();
      setAdding(false);
      flash(`${KIND_LABEL[kind]} saved`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save that method');
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(id: string) {
    setMenuId(null);
    try {
      setMethods(
        await api<SavedPaymentMethodInfo[]>(`/api/me/payment-methods/${id}/default`, {
          method: 'POST',
          auth: true,
        }),
      );
      flash('Default method updated');
    } catch {
      setError('Could not update the default method');
    }
  }

  async function remove(id: string) {
    setMenuId(null);
    if (!confirm('Remove this payment method?')) return;
    try {
      setMethods(
        await api<SavedPaymentMethodInfo[]>(`/api/me/payment-methods/${id}`, {
          method: 'DELETE',
          auth: true,
        }),
      );
      flash('Payment method removed');
    } catch {
      setError('Could not remove that method');
    }
  }

  const counts = useMemo(() => {
    const rows = methods ?? [];
    return {
      total: rows.length,
      CARD: rows.filter((m) => m.kind === 'CARD').length,
      UPI: rows.filter((m) => m.kind === 'UPI').length,
      WALLET: rows.filter((m) => m.kind === 'WALLET').length,
    };
  }, [methods]);

  if (!methods) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-12 w-64 rounded-lg bg-cream-100" />
        <div className="h-96 rounded-2xl bg-cream-100" />
      </div>
    );
  }

  const thisYear = new Date().getFullYear();

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <Link href="/account" className="hover:text-brand-600">
          My Account
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Payment Methods</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-page-title text-ink-900">
            Saved Payment Methods{' '}
            <span className="t-caption font-normal text-gray-500">({counts.total})</span>
          </h1>
          <p className="t-section-desc mt-1 text-gray-500">
            Manage your cards, UPI and wallets for faster checkout.
          </p>
        </div>
        <button
          onClick={() => startAdd('CARD')}
          className="t-btn flex items-center gap-1.5 rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800"
        >
          <PlusIcon className="h-4 w-4" />
          Add New Payment Method
        </button>
      </div>

      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-5">
          {SECTIONS.map((section) => {
            const rows = methods.filter((m) => m.kind === section.kind);
            return (
              <section key={section.kind}>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="t-sub-heading text-ink-900">{section.title}</h2>
                  <button
                    onClick={() => startAdd(section.kind)}
                    className="t-caption font-semibold text-brand-600 hover:underline"
                  >
                    + Add
                  </button>
                </div>

                {rows.length === 0 ? (
                  <p className="t-caption mt-2 rounded-2xl border border-dashed border-gray-200 px-4 py-6 text-center text-gray-500">
                    {section.empty}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {rows.map((m) => (
                      <li
                        key={m.id}
                        className={`flex flex-wrap items-center gap-4 rounded-2xl border bg-white p-4 ${
                          m.isDefault ? 'border-brand-600' : 'border-gray-100'
                        }`}
                      >
                        <BrandMark brand={m.brand} />

                        <div className="min-w-0 flex-1">
                          <p className="t-card-label flex flex-wrap items-center gap-2 text-ink-900">
                            {m.brand}{' '}
                            {m.kind === 'CARD' ? 'Card' : m.kind === 'UPI' ? 'UPI' : 'Wallet'}
                            {m.isDefault && (
                              <span className="t-badge rounded bg-cream-200 px-1.5 py-0.5 uppercase text-gray-600">
                                Default
                              </span>
                            )}
                            {m.isExpired && (
                              <span className="t-badge rounded bg-red-50 px-1.5 py-0.5 uppercase text-red-600">
                                Expired
                              </span>
                            )}
                          </p>
                          <p className="t-card-label mt-1 tracking-widest text-gray-700">
                            {m.kind === 'CARD' ? `•••• •••• •••• ${m.label}` : m.label}
                          </p>
                          {m.holderName && (
                            <p className="t-caption mt-0.5 text-gray-500">{m.holderName}</p>
                          )}
                        </div>

                        <div className="shrink-0 text-right">
                          {m.expiryMonth && m.expiryYear && (
                            <p className="t-caption text-gray-500">
                              Expires {String(m.expiryMonth).padStart(2, '0')}/
                              {String(m.expiryYear).slice(-2)}
                            </p>
                          )}
                          <p className="t-caption mt-0.5 flex items-center justify-end gap-1 text-green-700">
                            <ShieldCheckIcon className="h-3.5 w-3.5" />
                            Stored securely
                          </p>
                        </div>

                        <div className="relative shrink-0">
                          <button
                            onClick={() => setMenuId(menuId === m.id ? null : m.id)}
                            aria-label="Payment method actions"
                            className="rounded-full px-2 py-1 text-lg leading-none text-gray-400 hover:bg-cream-100"
                          >
                            ⋮
                          </button>
                          {menuId === m.id && (
                            <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-xl">
                              {!m.isDefault && (
                                <button
                                  onClick={() => void makeDefault(m.id)}
                                  className="t-caption block w-full px-4 py-2 text-left text-gray-700 hover:bg-cream-100"
                                >
                                  Make default
                                </button>
                              )}
                              <button
                                onClick={() => void remove(m.id)}
                                className="t-caption block w-full px-4 py-2 text-left text-red-600 hover:bg-red-50"
                              >
                                Remove
                              </button>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}

          {/* Add form */}
          <div ref={formRef}>
            {adding && (
              <form
                onSubmit={(e) => void save(e)}
                className="rounded-2xl border border-gray-100 bg-white p-5"
              >
                <h2 className="t-sub-heading text-ink-900">Add a payment method</h2>

                <div className="mt-3 flex flex-wrap gap-2">
                  {SECTIONS.map((s) => (
                    <button
                      key={s.kind}
                      type="button"
                      onClick={() => {
                        setKind(s.kind);
                        setBrand(PROVIDERS[s.kind][0]);
                        setError('');
                      }}
                      className={`t-btn rounded-lg border px-4 py-2 transition ${
                        kind === s.kind
                          ? 'border-brand-600 bg-brand-50 text-brand-700'
                          : 'border-gray-300 text-gray-500 hover:border-gray-400'
                      }`}
                    >
                      {KIND_LABEL[s.kind]}
                    </button>
                  ))}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="t-caption text-gray-600">
                    {kind === 'CARD' ? 'Card network' : kind === 'UPI' ? 'UPI app' : 'Wallet'}
                    <select
                      value={brand}
                      onChange={(e) => setBrand(e.target.value)}
                      className={`mt-1 ${field}`}
                    >
                      {PROVIDERS[kind].map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="t-caption text-gray-600">
                    {kind === 'CARD' ? 'Last 4 digits' : 'UPI ID'}
                    <input
                      name="label"
                      maxLength={kind === 'CARD' ? 4 : 40}
                      inputMode={kind === 'CARD' ? 'numeric' : 'text'}
                      placeholder={kind === 'CARD' ? '4242' : 'name@bank'}
                      className={`mt-1 ${field}`}
                      required
                    />
                  </label>

                  {kind === 'CARD' && (
                    <>
                      <label className="t-caption text-gray-600 sm:col-span-2">
                        Name on card
                        <input
                          name="holderName"
                          maxLength={60}
                          placeholder="As printed on the card"
                          className={`mt-1 ${field}`}
                        />
                      </label>
                      <label className="t-caption text-gray-600">
                        Expiry month
                        <input
                          name="expiryMonth"
                          type="number"
                          min={1}
                          max={12}
                          placeholder="12"
                          className={`mt-1 ${field}`}
                          required
                        />
                      </label>
                      <label className="t-caption text-gray-600">
                        Expiry year
                        <input
                          name="expiryYear"
                          type="number"
                          min={thisYear}
                          max={thisYear + 20}
                          placeholder={String(thisYear + 2)}
                          className={`mt-1 ${field}`}
                          required
                        />
                      </label>
                    </>
                  )}
                </div>

                <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-gray-600">
                  <input type="checkbox" name="isDefault" className="h-4 w-4 accent-brand-600" />
                  Make this my default method
                </label>

                <p className="t-caption mt-3 flex items-start gap-2 rounded-lg bg-cream-50 px-3 py-2 text-gray-500">
                  <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                  Never enter a full card number or CVV here. Clowe only keeps the network and last
                  4 digits so you can recognise the card — the real details are entered on the
                  gateway.
                </p>

                <div className="mt-4 flex gap-2">
                  <button
                    disabled={busy}
                    className="t-btn rounded-lg bg-brand-600 px-5 py-2.5 text-white transition hover:bg-brand-700 disabled:opacity-50"
                  >
                    {busy ? 'Saving…' : 'Save method'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdding(false)}
                    className="t-btn rounded-lg border border-gray-300 px-5 py-2.5 text-gray-600"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>

        {/* ── Right rail ─────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Payment Summary</h2>
            <dl className="mt-3 space-y-2.5">
              {[
                { label: 'Total Methods', value: counts.total },
                { label: 'Cards', value: counts.CARD },
                { label: 'UPI Accounts', value: counts.UPI },
                { label: 'Wallets', value: counts.WALLET },
              ].map((row) => (
                <div key={row.label} className="flex justify-between">
                  <dt className="t-caption text-gray-600">{row.label}</dt>
                  <dd className="t-card-label text-ink-900">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4">
            <p className="t-card-label flex items-center gap-2 text-ink-900">
              <ShieldCheckIcon className="h-4 w-4 text-brand-600" />
              How we store this
            </p>
            <p className="t-caption mt-2 text-gray-600">
              Clowe never stores full card numbers or CVVs — only the network, last 4 digits and
              expiry, so you can recognise the card. Every payment is authorised on the
              gateway&apos;s own secure page.
            </p>
            <p className="t-caption mt-2 flex items-center gap-1.5 font-semibold text-green-700">
              <LockIcon className="h-3.5 w-3.5" />
              100% Secure Payments
            </p>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Quick Actions</h2>
            <ul className="mt-3 divide-y divide-gray-100">
              {SECTIONS.map((s) => (
                <li key={s.kind}>
                  <button
                    onClick={() => startAdd(s.kind)}
                    className="flex w-full items-center gap-2.5 py-3 text-left transition hover:text-brand-600"
                  >
                    <CardIcon className="h-4 w-4 shrink-0 text-gray-500" />
                    <span className="min-w-0 flex-1">
                      <span className="t-card-label block text-ink-900">
                        Add {KIND_LABEL[s.kind]}
                      </span>
                      <span className="t-caption block text-gray-500">
                        {PROVIDERS[s.kind].slice(0, 3).join(', ')} &amp; more
                      </span>
                    </span>
                    <span className="shrink-0 text-gray-300">›</span>
                  </button>
                </li>
              ))}
              <li>
                <Link
                  href="/orders"
                  className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                >
                  <BoxIcon className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="min-w-0 flex-1">
                    <span className="t-card-label block text-ink-900">Payment history</span>
                    <span className="t-caption block text-gray-500">
                      See what you paid on each order
                    </span>
                  </span>
                  <span className="shrink-0 text-gray-300">›</span>
                </Link>
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4 text-center">
            <span className="text-2xl">🎧</span>
            <p className="t-card-label mt-1 text-ink-900">Need Help?</p>
            <p className="t-caption text-gray-500">Facing issues with payments?</p>
            <button
              onClick={() => window.dispatchEvent(new Event(SUPPORT_CHAT_EVENT))}
              className="t-btn mt-3 w-full rounded-lg bg-brand-600 py-2.5 text-white transition hover:bg-brand-700"
            >
              Contact Support
            </button>
          </div>
        </aside>
      </div>

      {/* Trust strip */}
      <section className="grid gap-3 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-2 lg:grid-cols-5">
        {TRUST_STRIP.map(({ Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="t-caption font-bold text-ink-900">{title}</p>
              <p className="t-caption text-gray-500">{text}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
