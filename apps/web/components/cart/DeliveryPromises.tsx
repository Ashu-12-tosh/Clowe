'use client';

import { useEffect, useState } from 'react';
import type { CartDeliveryPromises, SellerDeliveryPromiseView } from '@clowe/shared';
import { api } from '@/lib/api';
import { rememberPin, startingPin } from '@/lib/deliveryPin';
import { MapPinIcon } from '@/components/cart/CartIcons';

// ---------------------------------------------------------------------------
// Each seller's delivery date in the cart and at checkout: one estimate per
// seller (their dispatch promise and Delhivery's transit time from their
// pickup pincode, plus a day), for the chosen address or the session's PIN.
// ---------------------------------------------------------------------------

/** The cart's promises for an address (checkout) or a PIN (cart). Refetched when `refreshKey` changes. */
export function useCartPromises(target: { addressId?: string | null; pincode?: string | null }, refreshKey: unknown = null) {
  const [data, setData] = useState<CartDeliveryPromises | null>(null);
  const { addressId, pincode } = target;
  useEffect(() => {
    if (!addressId && !(pincode && /^\d{6}$/.test(pincode))) {
      setData(null);
      return;
    }
    let live = true;
    const query = new URLSearchParams(addressId ? { addressId } : { pincode: pincode! });
    api<CartDeliveryPromises>(`/api/cart/delivery-promises?${query.toString()}`, { auth: true })
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [addressId, pincode, refreshKey]);
  return data;
}

/** The seller promise a cart line ships under. */
export function promiseForLine(data: CartDeliveryPromises | null, variantId: string): SellerDeliveryPromiseView | null {
  const sellerId = data?.lines.find((l) => l.variantId === variantId)?.sellerId;
  return data?.sellers.find((s) => s.sellerId === sellerId) ?? null;
}

/** One line's "Delivery by Thu, 29 Oct · Free delivery", or why it can't come. */
export function LinePromise({ promise }: { promise: SellerDeliveryPromiseView | null }) {
  if (!promise) return null;
  if (promise.deliverable === false) {
    return (
      <p className="mt-1 text-xs font-semibold text-red-600" data-line-promise="not-available">
        {promise.label}
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs font-medium text-ink-900" data-line-promise="deliverable">
      {promise.label} <span className="font-semibold text-green-600">· Free delivery</span>
    </p>
  );
}

/** The cart's "Delivery to 110053 · Change", from the session's PIN or the default address. */
export function CartPinBar({ onPin }: { onPin: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void startingPin().then((p) => {
      setPin(p);
      setDraft(p);
      setEditing(!p);
      onPin(p);
    });
    // Once, on mount: onPin is the page's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function apply() {
    const p = draft.trim();
    if (!/^\d{6}$/.test(p)) {
      setError('Enter a valid 6-digit pincode');
      return;
    }
    setError('');
    rememberPin(p);
    setPin(p);
    setEditing(false);
    onPin(p);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2.5 text-sm" data-cart-pin>
      <MapPinIcon className="h-4 w-4 text-gray-500" />
      {editing ? (
        <>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
            placeholder="Delivery pincode"
            aria-label="Delivery pincode"
            inputMode="numeric"
            className="w-36 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-600"
          />
          <button onClick={apply} className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white">
            Check
          </button>
          {error && <span className="text-xs font-medium text-red-600">{error}</span>}
        </>
      ) : (
        <>
          <span className="text-gray-600">
            Delivery dates for <span className="font-semibold text-ink-900">{pin}</span>
          </span>
          <button
            onClick={() => {
              setDraft(pin);
              setEditing(true);
            }}
            className="text-xs font-semibold text-brand-600 hover:underline"
          >
            Change
          </button>
        </>
      )}
    </div>
  );
}
