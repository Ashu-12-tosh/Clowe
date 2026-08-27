'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DeliveryMethod, DeliveryQuote } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { MapPinIcon } from '@/components/cart/CartIcons';

const PINCODE_KEY = 'clowe.pincode';

interface Props {
  /** Item price the free-shipping rule is checked against. */
  subtotalPaise: number;
}

/**
 * "Delivering to <pincode>" with the speeds available there. The pincode is
 * remembered locally so it follows the shopper between products.
 */
export default function DeliveryCard({ subtotalPaise }: Props) {
  const [pincode, setPincode] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [method, setMethod] = useState<DeliveryMethod>('STANDARD');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(PINCODE_KEY) ?? '';
    setPincode(saved);
    setDraft(saved);
    setEditing(!saved);
  }, []);

  const load = useCallback(
    (pin: string) => {
      setLoading(true);
      const query = new URLSearchParams({ subtotalPaise: String(subtotalPaise) });
      if (pin) query.set('pincode', pin);
      api<DeliveryQuote>(`/api/delivery/options?${query.toString()}`)
        .then((q) => {
          setQuote(q);
          // Keep the current pick only while it is still offered.
          setMethod((m) => (q.options.find((o) => o.method === m)?.available ? m : 'STANDARD'));
        })
        .catch(() => setQuote(null))
        .finally(() => setLoading(false));
    },
    [subtotalPaise],
  );

  useEffect(() => {
    load(pincode);
  }, [load, pincode]);

  function apply() {
    const pin = draft.trim();
    if (!/^\d{6}$/.test(pin)) {
      setQuote({ pincode: pin, serviceable: false, message: 'Enter a valid 6-digit pincode', options: [] });
      return;
    }
    localStorage.setItem(PINCODE_KEY, pin);
    setPincode(pin);
    setEditing(false);
  }

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
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

      {quote && !quote.serviceable && quote.message && (
        <p className="mt-2 text-xs font-medium text-red-600">{quote.message}</p>
      )}

      {loading && !quote && <p className="mt-3 text-xs text-gray-400">Checking…</p>}

      {quote?.serviceable && (
        <div className="mt-3 space-y-2 border-t border-gray-100 pt-3">
          {quote.options.map((option) => (
            <label
              key={option.method}
              className={`flex items-start gap-2.5 ${
                option.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
              }`}
            >
              <input
                type="radio"
                name="pdp-delivery"
                checked={method === option.method}
                disabled={!option.available}
                onChange={() => setMethod(option.method)}
                className="mt-0.5 h-4 w-4 accent-ink-900"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink-900">{option.label}</span>
                <span className="block text-xs text-gray-500">
                  {option.unavailableReason ?? option.etaLabel}
                </span>
              </span>
              <span
                className={`shrink-0 text-sm font-bold ${
                  option.pricePaise === 0 ? 'text-green-600' : 'text-ink-900'
                }`}
              >
                {option.pricePaise === 0 ? 'FREE' : formatPaise(option.pricePaise)}
              </span>
            </label>
          ))}
          <p className="pt-1 text-[11px] text-gray-400">
            Pick your final speed at checkout — prices shown are for this order value.
          </p>
        </div>
      )}
    </div>
  );
}
