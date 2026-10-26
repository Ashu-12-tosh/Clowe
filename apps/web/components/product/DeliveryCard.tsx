'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ProductDeliveryPromise } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { rememberPin, startingPin } from '@/lib/deliveryPin';
import { MapPinIcon } from '@/components/cart/CartIcons';

interface Props {
  productId: string;
}

/**
 * "Delivery by Thu, 29 Oct · Free delivery" for the shopper's PIN, from this
 * product's seller: their dispatch promise and Delhivery's transit time from
 * their pickup pincode. The PIN is kept for the session (and starts from a
 * logged-in buyer's default address), so it follows them to other products
 * and the cart.
 */
export default function DeliveryCard({ productId }: Props) {
  const [pincode, setPincode] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [promise, setPromise] = useState<ProductDeliveryPromise | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    void startingPin().then((pin) => {
      if (!live) return;
      setPincode(pin);
      setDraft(pin);
      setEditing(!pin);
    });
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(
    (pin: string) => {
      if (!pin) return;
      setLoading(true);
      setError(null);
      api<ProductDeliveryPromise>(`/api/delivery/promise?${new URLSearchParams({ productId, pincode: pin }).toString()}`)
        .then(setPromise)
        .catch((err) => {
          setPromise(null);
          setError(err instanceof ApiRequestError ? err.message : 'Could not check delivery just now');
        })
        .finally(() => setLoading(false));
    },
    [productId],
  );

  useEffect(() => {
    load(pincode);
  }, [load, pincode]);

  function apply() {
    const pin = draft.trim();
    if (!/^\d{6}$/.test(pin)) {
      setPromise(null);
      setError('Enter a valid 6-digit pincode');
      return;
    }
    rememberPin(pin);
    setPincode(pin);
    setEditing(false);
  }

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4" data-delivery-card>
      <div className="flex items-center gap-2">
        <MapPinIcon className="h-4 w-4 text-gray-500" />
        <p className="text-sm font-bold text-ink-900">Delivery</p>
      </div>

      {editing ? (
        <div className="mt-3 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
            placeholder="Enter 6-digit pincode"
            aria-label="Delivery pincode"
            inputMode="numeric"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
          />
          <button
            onClick={apply}
            className="rounded-lg bg-ink-900 px-4 text-xs font-bold uppercase tracking-wide text-white transition hover:bg-ink-800"
          >
            Check
          </button>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-1.5 text-gray-600">
            <MapPinIcon className="h-3.5 w-3.5 text-gray-400" />
            Delivering to <span className="font-semibold text-ink-900">{pincode}</span>
          </span>
          <button
            onClick={() => {
              setDraft(pincode);
              setEditing(true);
            }}
            className="text-xs font-semibold text-brand-600 hover:underline"
          >
            Change
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}
      {loading && !promise && <p className="mt-3 text-xs text-gray-400">Checking…</p>}

      {promise && !editing && (
        <p
          className={`mt-3 border-t border-gray-100 pt-3 text-sm font-semibold ${promise.deliverable ? 'text-ink-900' : 'text-red-600'}`}
          data-delivery-promise={promise.deliverable ? 'deliverable' : 'not-available'}
        >
          {promise.deliverable ? (
            <>
              {promise.message.replace(' · Free delivery', '')}
              <span className="font-bold text-green-600"> · Free delivery</span>
            </>
          ) : (
            promise.message
          )}
        </p>
      )}
    </div>
  );
}
