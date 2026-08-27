'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ADDRESS_LABELS,
  ADDRESS_LABEL_TEXT,
  addressUpsertSchema,
  CREDIT_VALUE_PAISE,
  creditsToPaise,
  type AddressInfo,
  type AddressLabel,
  type CartView,
  type CreditsInfo,
  type DeliveryMethod,
  type DeliveryOption,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { BADGES_EVENT } from '@/components/Header';
import CheckoutStepper, { type CheckoutStep } from '@/components/checkout/CheckoutStepper';
import CouponBox from '@/components/checkout/CouponBox';
import FrequentlyBought from '@/components/checkout/FrequentlyBought';
import {
  BoltIcon,
  BoxIcon,
  ClockIcon,
  GiftIcon,
  HeadsetIcon,
  LeafIcon,
  LockIcon,
  MapPinIcon,
  PlusIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

const WHY_SHOP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns within 7 days' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Customer Support', text: 'We are here for you' },
];

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns within 7 days' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

const PAYMENT_METHODS = ['VISA', 'Mastercard', 'RuPay', 'UPI', 'Paytm'];

const DELIVERY_ICON: Record<DeliveryMethod, typeof TruckIcon> = {
  STANDARD: TruckIcon,
  EXPRESS: BoltIcon,
  SAME_DAY: ClockIcon,
};

/** Section shell — numbered heading + card, matching the checkout steps. */
function Step({
  n,
  title,
  action,
  children,
}: {
  n: number;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-base font-bold text-ink-900">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-900 text-xs font-bold text-white">
            {n}
          </span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const [cart, setCart] = useState<CartView | null>(null);
  const [addresses, setAddresses] = useState<AddressInfo[] | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [showAllAddresses, setShowAllAddresses] = useState(false);
  const [addressLabel, setAddressLabel] = useState<AddressLabel>('HOME');
  const [error, setError] = useState('');
  // Shopping credits (optional discount — the user's choice).
  const [credits, setCredits] = useState<CreditsInfo | null>(null);
  const [useCredits, setUseCredits] = useState(false);
  // Delivery speed + gifting.
  const [deliveryOptions, setDeliveryOptions] = useState<DeliveryOption[]>([]);
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>('STANDARD');
  const [isGift, setIsGift] = useState(false);
  const [giftMessage, setGiftMessage] = useState('');

  const applyCart = useCallback((next: CartView) => {
    setCart(next);
    window.dispatchEvent(new Event(BADGES_EVENT));
  }, []);

  /** Delivery prices depend on the subtotal, so they reload with the cart. */
  const loadDeliveryOptions = useCallback(() => {
    api<DeliveryOption[]>('/api/cart/delivery-options', { auth: true })
      .then((options) => {
        setDeliveryOptions(options);
        setDeliveryMethod((current) =>
          options.find((o) => o.method === current)?.available ? current : 'STANDARD',
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    api<CartView>('/api/cart', { auth: true }).then(setCart).catch(() => {});
    api<CreditsInfo>('/api/credits', { auth: true }).then(setCredits).catch(() => {});
    api<AddressInfo[]>('/api/addresses', { auth: true })
      .then((list) => {
        setAddresses(list);
        const def = list.find((a) => a.isDefault) ?? list[0];
        if (def) setSelectedAddress(def.id);
        if (list.length === 0) setShowAddressForm(true);
      })
      .catch(() => setAddresses([]));
    loadDeliveryOptions();
  }, [router, loadDeliveryOptions]);

  // Adding an add-on or applying a coupon changes the subtotal, which can
  // flip standard shipping between free and ₹49.
  useEffect(() => {
    if (cart) loadDeliveryOptions();
  }, [cart, loadDeliveryOptions]);

  // "Buy Now" from the cart lands here with ?express=1 — same flow, but it
  // jumps straight to the pay panel instead of the address list.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('express') !== '1') return;
    if (!cart || !selectedAddress) return;
    document.getElementById('pay-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [cart, selectedAddress]);

  async function saveAddress(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const raw = Object.fromEntries(
      [...new FormData(e.currentTarget).entries()].filter(([, v]) => String(v).trim() !== ''),
    );
    const parsed = addressUpsertSchema.safeParse({ ...raw, label: addressLabel });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join('.')}: ${issue.message}`);
      return;
    }
    try {
      const created = await api<AddressInfo>('/api/addresses', { body: parsed.data, auth: true });
      setAddresses((prev) => [created, ...(prev ?? [])]);
      setSelectedAddress(created.id);
      setShowAddressForm(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save address');
    }
  }

  /** Carry the choices made here into the payment step. */
  function continueToPayment() {
    if (!selectedAddress) {
      setError('Pick a delivery address to continue');
      return;
    }
    const params = new URLSearchParams({
      addressId: selectedAddress,
      deliveryMethod,
      useCredits: String(useCredits),
      isGift: String(isGift),
    });
    if (isGift && giftMessage.trim()) params.set('giftMessage', giftMessage.trim());
    router.push(`/checkout/payment?${params.toString()}`);
  }

  // --- Derived totals --------------------------------------------------------

  const lines = useMemo(() => cart?.lines.filter((l) => l.selected) ?? [], [cart]);
  const chosenDelivery = deliveryOptions.find((o) => o.method === deliveryMethod) ?? null;
  const shippingPaise = chosenDelivery?.pricePaise ?? cart?.shippingPaise ?? 0;
  const itemTotalPaise = cart?.subtotalPaise ?? 0;
  const couponDiscountPaise = cart?.couponDiscountPaise ?? 0;
  // Mirrors the server rule: credits can't take the payable below ₹1.
  const beforeCredits = itemTotalPaise + shippingPaise - couponDiscountPaise;
  const creditsUsable =
    useCredits && credits
      ? Math.min(credits.balance, Math.floor(Math.max(0, beforeCredits - 100) / CREDIT_VALUE_PAISE))
      : 0;
  const creditsDiscountPaise = creditsToPaise(creditsUsable);
  const totalPaise = beforeCredits - creditsDiscountPaise;
  const savingsPaise =
    (cart?.discountPaise ?? 0) +
    (cart?.promoDiscountPaise ?? 0) +
    couponDiscountPaise +
    creditsDiscountPaise;
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const shipTo = addresses?.find((a) => a.id === selectedAddress) ?? null;

  const currentStep: CheckoutStep = selectedAddress ? 'payment' : 'address';
  const visibleAddresses =
    addresses && !showAllAddresses ? addresses.slice(0, 2) : (addresses ?? []);

  if (!cart) {
    return (
      <main className="mx-auto max-w-7xl animate-pulse px-4 py-6">
        <div className="h-8 w-40 rounded-lg bg-cream-100" />
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="h-96 rounded-2xl bg-cream-100" />
          <div className="h-80 rounded-2xl bg-cream-100" />
        </div>
      </main>
    );
  }

  if (lines.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <span className="text-5xl">🛍</span>
        <h1 className="mt-4 font-display text-2xl font-bold text-ink-900">Nothing to check out</h1>
        <p className="mt-2 text-sm text-gray-500">
          Your cart has no selected items. Pick something first.
        </p>
        <Link
          href="/cart"
          className="mt-6 inline-block rounded-lg bg-ink-900 px-8 py-3 text-sm font-bold uppercase tracking-wide text-white transition hover:bg-ink-800"
        >
          Back to Cart
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-24 pt-4 lg:pb-8">
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <Link href="/cart" className="hover:text-brand-600">
          Cart
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Checkout</span>
      </nav>

      <h1 className="t-page-title mt-2 text-ink-900">Checkout</h1>
      <CheckoutStepper current={currentStep} />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ── Left column ────────────────────────────────────────────────── */}
        <div className="space-y-4">
          {/* 1 ─ Delivery address */}
          <Step n={1} title="Delivery Address">
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visibleAddresses.map((a) => {
                const active = selectedAddress === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => setSelectedAddress(a.id)}
                    className={`relative rounded-xl border p-3 text-left transition ${
                      active
                        ? 'border-brand-600 bg-brand-50/40 ring-1 ring-brand-600'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <MapPinIcon className="h-4 w-4 text-gray-500" />
                      <span className="text-sm font-bold text-ink-900">
                        {ADDRESS_LABEL_TEXT[a.label]}
                      </span>
                      {a.isDefault && (
                        <span className="rounded bg-cream-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600">
                          Default
                        </span>
                      )}
                      <span
                        className={`ml-auto flex h-4 w-4 items-center justify-center rounded-full border ${
                          active ? 'border-brand-600 bg-brand-600' : 'border-gray-300'
                        }`}
                      >
                        {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </span>
                    </span>
                    <p className="mt-2 text-sm font-semibold text-ink-900">{a.name}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
                      {a.line1}
                      {a.line2 ? `, ${a.line2}` : ''}
                      {a.landmark ? `, ${a.landmark}` : ''}
                      <br />
                      {a.city}, {a.state} - {a.pincode}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">+91 {a.phone}</p>
                  </button>
                );
              })}

              {!showAddressForm && (
                <button
                  onClick={() => setShowAddressForm(true)}
                  className="flex min-h-[9rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 p-3 text-gray-500 transition hover:border-brand-600 hover:text-brand-600"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full border border-current">
                    <PlusIcon />
                  </span>
                  <span className="text-sm font-semibold">Add New Address</span>
                </button>
              )}
            </div>

            {addresses && addresses.length > 2 && (
              <button
                onClick={() => setShowAllAddresses((v) => !v)}
                className="mt-3 text-sm font-semibold text-brand-600 hover:underline"
              >
                {showAllAddresses
                  ? 'Show fewer addresses ‹'
                  : `View all saved addresses (${addresses.length}) ›`}
              </button>
            )}

            {showAddressForm && (
              <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={(e) => void saveAddress(e)}>
                <div className="flex gap-2 sm:col-span-2">
                  {ADDRESS_LABELS.map((label) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setAddressLabel(label)}
                      className={`rounded-lg border px-4 py-1.5 text-xs font-bold uppercase tracking-wide transition ${
                        addressLabel === label
                          ? 'border-brand-600 bg-brand-50 text-brand-700'
                          : 'border-gray-300 text-gray-500 hover:border-gray-400'
                      }`}
                    >
                      {ADDRESS_LABEL_TEXT[label]}
                    </button>
                  ))}
                </div>
                <input name="name" placeholder="Full name *" className={field} required />
                <input name="phone" placeholder="10-digit phone *" className={field} required maxLength={10} />
                <input name="line1" placeholder="House no, street *" className={`sm:col-span-2 ${field}`} required />
                <input name="line2" placeholder="Area, locality" className={`sm:col-span-2 ${field}`} />
                <input name="landmark" placeholder="Landmark" className={field} />
                <input name="pincode" placeholder="Pincode *" className={field} required maxLength={6} />
                <input name="city" placeholder="City *" className={field} required />
                <input name="state" placeholder="State *" className={field} required />
                <div className="flex gap-2 sm:col-span-2">
                  <button className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                    Save address
                  </button>
                  {addresses && addresses.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAddressForm(false)}
                      className="rounded-lg border border-gray-300 px-5 py-2 text-sm text-gray-600"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            )}
          </Step>

          {/* 2 ─ Delivery options */}
          <Step n={2} title="Delivery Options">
            <div className="mt-3 space-y-2.5">
              {deliveryOptions.map((option) => {
                const Icon = DELIVERY_ICON[option.method];
                const active = deliveryMethod === option.method;
                return (
                  <label
                    key={option.method}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${
                      !option.available
                        ? 'cursor-not-allowed border-gray-200 opacity-50'
                        : active
                          ? 'border-brand-600 bg-brand-50/40 ring-1 ring-brand-600'
                          : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="delivery"
                      checked={active}
                      disabled={!option.available}
                      onChange={() => setDeliveryMethod(option.method)}
                      className="h-4 w-4 accent-brand-600"
                    />
                    <Icon className="h-5 w-5 shrink-0 text-gray-600" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold text-ink-900">{option.label}</span>
                      <span className="block text-xs text-gray-500">
                        {option.unavailableReason ?? option.etaLabel}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span
                        className={`text-sm font-bold ${
                          option.pricePaise === 0 ? 'text-green-600' : 'text-ink-900'
                        }`}
                      >
                        {option.pricePaise === 0 ? 'FREE' : formatPaise(option.pricePaise)}
                      </span>
                      {option.strikePaise !== null && (
                        <span className="text-xs text-gray-400 line-through">
                          {formatPaise(option.strikePaise)}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            {chosenDelivery && chosenDelivery.strikePaise !== null && (
              <p className="mt-3 flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-xs font-semibold text-green-700">
                <LeafIcon className="h-4 w-4 shrink-0" />
                Yay! You are saving{' '}
                {formatPaise(chosenDelivery.strikePaise - chosenDelivery.pricePaise)} with{' '}
                {chosenDelivery.pricePaise === 0 ? 'FREE ' : ''}
                {chosenDelivery.label}.
              </p>
            )}
          </Step>

          {/* 3 ─ Gift options */}
          <Step n={3} title="Gift Options">
            <div className="mt-3 flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={isGift}
                    onChange={(e) => setIsGift(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-brand-600"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-ink-900">This is a gift</span>
                    <span className="block text-xs text-gray-500">
                      Add a personalized message — we hide the prices on the invoice.
                    </span>
                  </span>
                </label>
                {isGift && (
                  <div className="mt-3">
                    <textarea
                      value={giftMessage}
                      onChange={(e) => setGiftMessage(e.target.value.slice(0, 200))}
                      rows={3}
                      placeholder="Write your gift message…"
                      aria-label="Gift message"
                      className={field}
                    />
                    <p className="mt-1 text-right text-[11px] text-gray-400">
                      {giftMessage.length}/200
                    </p>
                  </div>
                )}
              </div>
              <GiftIcon className="h-12 w-12 shrink-0 text-brand-400" />
            </div>
          </Step>

          {/* 4 ─ Coupons & credits */}
          <Step n={4} title="Coupons & Gift Cards">
            <div className="mt-3">
              <CouponBox
                applied={cart.coupon}
                subtotalPaise={cart.subtotalPaise}
                onCartChange={applyCart}
              />
            </div>

            {credits && credits.balance > 0 && (
              <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl border border-brand-100 bg-brand-50/50 p-3">
                <input
                  type="checkbox"
                  checked={useCredits}
                  onChange={(e) => setUseCredits(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-brand-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-900">
                    Use my Clowe Credits — 🪙 {credits.balance} ={' '}
                    {formatPaise(credits.valuePaise)}
                  </span>
                  <span className="block text-xs text-gray-500">
                    10 credits = ₹5 · applied as an instant discount
                    {creditsDiscountPaise > 0 &&
                      ` · using ${creditsUsable} (${formatPaise(creditsDiscountPaise)})`}
                  </span>
                </span>
              </label>
            )}
          </Step>

          {/* 5 ─ Review items */}
          <Step
            n={5}
            title={`Review Items (${itemCount} Item${itemCount === 1 ? '' : 's'})`}
            action={
              <Link href="/cart" className="text-sm font-semibold text-brand-600 hover:underline">
                Edit Cart
              </Link>
            }
          >
            <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
              {lines.map((line) => (
                <Link
                  key={line.id}
                  href={`/products/${line.slug}`}
                  className="w-32 shrink-0 rounded-xl border border-gray-200 p-2 transition hover:border-brand-600"
                >
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={line.imageUrl}
                      alt=""
                      loading="lazy"
                      className="h-28 w-full rounded-lg bg-cream-100 object-cover"
                    />
                  ) : (
                    <div className="h-28 w-full rounded-lg bg-cream-100" />
                  )}
                  <p className="mt-2 line-clamp-2 text-xs font-semibold text-ink-900">
                    {line.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    {line.size !== 'One Size' ? `Size: ${line.size} | ` : ''}Qty: {line.quantity}
                  </p>
                  <p className="mt-0.5 text-xs font-bold text-ink-900">
                    {formatPaise(line.pricePaise * line.quantity)}
                  </p>
                </Link>
              ))}
            </div>
          </Step>

          <FrequentlyBought
            excludeIds={cart.lines.map((l) => l.productId)}
            onCartChange={applyCart}
          />
        </div>

        {/* ── Right: order summary ───────────────────────────────────────── */}
        <aside id="pay-panel" className="space-y-4 lg:sticky lg:top-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-base font-bold text-ink-900">Order Summary</h2>

            <ul className="mt-3 divide-y divide-gray-100">
              {lines.map((line) => (
                <li key={line.id} className="flex items-start gap-3 py-2.5">
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={line.imageUrl}
                      alt=""
                      loading="lazy"
                      className="h-12 w-10 shrink-0 rounded bg-cream-100 object-cover"
                    />
                  ) : (
                    <div className="h-12 w-10 shrink-0 rounded bg-cream-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-xs font-semibold text-ink-900">{line.title}</p>
                    <p className="mt-0.5 text-[11px] text-gray-500">
                      {line.size !== 'One Size' ? `Size: ${line.size} | ` : ''}Qty: {line.quantity}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-bold text-ink-900">
                    {formatPaise(line.pricePaise * line.quantity)}
                  </span>
                </li>
              ))}
            </ul>

            <dl className="mt-3 space-y-2 border-t border-gray-200 pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-600">
                  Item Total ({itemCount} Item{itemCount === 1 ? '' : 's'})
                </dt>
                <dd className="font-semibold text-ink-900">{formatPaise(itemTotalPaise)}</dd>
              </div>
              {(cart.promotions ?? []).map((promo) => (
                <div key={promo.id} className="flex justify-between">
                  <dt className="text-gray-600">
                    {promo.name}
                    <span className="ml-1 text-[11px] text-gray-400">
                      {promo.code ? `(${promo.code})` : '(seller offer)'}
                    </span>
                  </dt>
                  <dd className="font-semibold text-green-600">
                    −{formatPaise(promo.discountPaise)}
                  </dd>
                </div>
              ))}
              {couponDiscountPaise > 0 && (
                <div className="flex justify-between">
                  <dt className="text-gray-600">
                    Coupon Discount{' '}
                    <span className="font-semibold text-brand-600">({cart.coupon?.code})</span>
                  </dt>
                  <dd className="font-semibold text-green-600">
                    −{formatPaise(couponDiscountPaise)}
                  </dd>
                </div>
              )}
              {creditsDiscountPaise > 0 && (
                <div className="flex justify-between">
                  <dt className="text-gray-600">Clowe Credits ({creditsUsable} 🪙)</dt>
                  <dd className="font-semibold text-green-600">
                    −{formatPaise(creditsDiscountPaise)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-gray-600">
                  Shipping Charges
                  {chosenDelivery && (
                    <span className="block text-[11px] text-gray-400">({chosenDelivery.label})</span>
                  )}
                </dt>
                <dd className={shippingPaise === 0 ? 'font-bold text-green-600' : 'font-semibold'}>
                  {shippingPaise === 0 ? 'FREE' : formatPaise(shippingPaise)}
                </dd>
              </div>
            </dl>

            <div className="mt-3 flex items-baseline justify-between border-t border-gray-200 pt-3">
              <span className="font-bold text-ink-900">
                Total Amount{' '}
                <span className="block text-[11px] font-normal text-gray-400">
                  (Inclusive of all taxes)
                </span>
              </span>
              <span className="t-cart-subtotal text-ink-900">{formatPaise(totalPaise)}</span>
            </div>

            {savingsPaise > 0 && (
              <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-center text-xs font-semibold text-green-700">
                You are saving {formatPaise(savingsPaise)} on this order!
              </p>
            )}

            {shipTo && chosenDelivery && (
              <div className="mt-3 flex items-start gap-2.5 border-t border-gray-100 pt-3">
                <TruckIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                <div className="min-w-0 text-xs text-gray-600">
                  <p className="truncate">
                    Delivering to: {shipTo.line1}, {shipTo.city}
                  </p>
                  <p className="mt-0.5 text-gray-500">
                    Estimated Delivery: {chosenDelivery.etaLabel.replace('Delivered by ', '')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Payment safety + methods */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-start gap-3">
              <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
              <div>
                <p className="text-sm font-bold text-ink-900">Safe &amp; Secure Payments</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  Your payment information is 100% secure
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {PAYMENT_METHODS.map((method) => (
                <span
                  key={method}
                  className="rounded-md border border-gray-200 px-2.5 py-1.5 text-[11px] font-bold tracking-wide text-gray-600"
                >
                  {method}
                </span>
              ))}
              <span className="rounded-md border border-gray-200 bg-cream-50 px-2.5 py-1.5 text-[11px] font-bold text-gray-500">
                +5
              </span>
            </div>
          </div>

          {/* Why shop */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm font-bold text-ink-900">Why shop at CLOWE?</p>
            <div className="mt-3 space-y-2.5">
              {WHY_SHOP.map(({ Icon, title, text }) => (
                <div key={title} className="flex items-start gap-2">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-ink-900">{title}</p>
                    <p className="text-[11px] text-gray-500">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="hidden lg:block">
            <button
              onClick={continueToPayment}
              disabled={!selectedAddress}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 py-3.5 text-sm font-bold text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              <LockIcon className="h-4 w-4" />
              Continue to Payment
            </button>
            <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs text-gray-400">
              <ShieldCheckIcon className="h-3.5 w-3.5" />
              You won&apos;t be charged at this step
            </p>
            {!selectedAddress && (
              <p className="mt-1 text-center text-xs font-medium text-orange-600">
                Pick a delivery address to continue
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* Bottom trust strip */}
      <section className="mt-6 grid gap-3 rounded-2xl border border-gray-100 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5">
        {TRUST_STRIP.map(({ Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-ink-900">{title}</p>
              <p className="text-[11px] text-gray-500">{text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Sticky mobile CTA */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-gray-200 bg-white px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] lg:hidden">
        <div>
          <p className="t-cart-price leading-none text-ink-900">{formatPaise(totalPaise)}</p>
          <p className="mt-0.5 text-[11px] text-gray-500">
            {itemCount} item{itemCount === 1 ? '' : 's'}
          </p>
        </div>
        <button
          onClick={continueToPayment}
          disabled={!selectedAddress}
          className="rounded-lg bg-brand-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-700 disabled:opacity-50"
        >
          Continue to Payment
        </button>
      </div>
    </main>
  );
}
