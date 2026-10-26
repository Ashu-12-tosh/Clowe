'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SellerDeliveryEstimate } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { ChargeableWeight, DeliveryCasesTable } from '@/components/seller/PricingBreakdown';

interface ParcelProduct {
  id: string;
  title: string;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

/**
 * Shipping charges calculator: what Delhivery charges for a parcel from the
 * seller's pickup pincode — forward, RTO and return pickup, zone by zone, GST
 * included — for a weight and box they type or one of their products, with
 * an optional PIN of their own besides the three sample places.
 */
export default function ShippingCalculatorPage() {
  const [products, setProducts] = useState<ParcelProduct[]>([]);
  const [productId, setProductId] = useState('');
  const [kg, setKg] = useState('0.5');
  const [l, setL] = useState('');
  const [w, setW] = useState('');
  const [h, setH] = useState('');
  const [pin, setPin] = useState('');
  const [estimate, setEstimate] = useState<SellerDeliveryEstimate | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ParcelProduct[]>('/api/seller/pricing-rates/parcels', { auth: true }).then(setProducts).catch(() => {});
  }, []);

  function pick(id: string) {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    if (!p) return;
    setKg(p.weightGrams ? String(p.weightGrams / 1000) : '');
    setL(p.lengthMm ? String(p.lengthMm / 10) : '');
    setW(p.widthMm ? String(p.widthMm / 10) : '');
    setH(p.heightMm ? String(p.heightMm / 10) : '');
  }

  async function calculate() {
    setError('');
    const grams = Math.round(Number(kg) * 1000);
    if (!grams || grams <= 0) return setError('Enter the weight in kg');
    if (pin && !/^[1-9]\d{5}$/.test(pin)) return setError('Enter a valid 6-digit PIN, or leave it empty');
    const query = new URLSearchParams({ weightGrams: String(grams) });
    const sides = [l, w, h].map((v) => Math.round(Number(v) * 10));
    if (sides.every((v) => v > 0)) {
      query.set('lengthMm', String(sides[0]));
      query.set('widthMm', String(sides[1]));
      query.set('heightMm', String(sides[2]));
    }
    if (pin) query.set('destinationPincode', pin);
    setBusy(true);
    try {
      setEstimate(await api<SellerDeliveryEstimate>(`/api/seller/pricing-rates/delivery-estimate?${query.toString()}`, { auth: true }));
    } catch (err) {
      setEstimate(null);
      setError(err instanceof ApiRequestError ? err.message : 'Could not get the estimate');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Shipping charges calculator</h1>
        <p className="mt-1 text-sm text-gray-500">
          What Delhivery charges you for one parcel from your pickup pincode, GST included. Buyers never pay for delivery.{' '}
          <Link href="/pages/delivery-charges" className="font-semibold text-brand-600 hover:underline" data-help-link>
            Delivery charges explained
          </Link>
        </p>
      </div>

      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-xs font-semibold text-gray-600 md:col-span-2">
            Pick one of your products (optional)
            <select value={productId} onChange={(e) => pick(e.target.value)} className={`${field} mt-1`} aria-label="Product">
              <option value="">— type a weight and box instead —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                  {p.weightGrams ? ` · ${p.weightGrams / 1000} kg` : ' · no weight yet'}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold text-gray-600">
            Weight (kg)
            <input value={kg} onChange={(e) => setKg(e.target.value)} inputMode="decimal" className={`${field} mt-1`} aria-label="Weight in kg" />
          </label>
          <div className="text-xs font-semibold text-gray-600">
            Box L × B × H (cm)
            <div className="mt-1 grid grid-cols-3 gap-2">
              <input value={l} onChange={(e) => setL(e.target.value)} inputMode="decimal" placeholder="L" className={field} aria-label="Length in cm" />
              <input value={w} onChange={(e) => setW(e.target.value)} inputMode="decimal" placeholder="B" className={field} aria-label="Breadth in cm" />
              <input value={h} onChange={(e) => setH(e.target.value)} inputMode="decimal" placeholder="H" className={field} aria-label="Height in cm" />
            </div>
          </div>
          <label className="block text-xs font-semibold text-gray-600">
            Another destination PIN (optional)
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="e.g. 560001"
              className={`${field} mt-1`}
              aria-label="Destination PIN"
            />
          </label>
          <div className="flex items-end">
            <button
              onClick={() => void calculate()}
              disabled={busy}
              className="rounded-lg bg-ink-900 px-5 py-2.5 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-50"
            >
              {busy ? 'Asking Delhivery…' : 'Calculate'}
            </button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
      </section>

      {estimate && (
        <section className="rounded-2xl border border-gray-100 bg-white p-4 text-xs" data-calculator-result>
          {estimate.error ? (
            <p className="text-amber-700">{estimate.error}</p>
          ) : (
            <>
              <ChargeableWeight estimate={estimate} />
              <DeliveryCasesTable estimate={estimate} keepPaise={null} />
              <p className="mt-2 text-[11px] text-gray-500">
                Forward is charged when the parcel is delivered. RTO is only if it comes back undelivered, on top of the forward. Return
                pickup is only when you approve a customer return. All include 18% GST; the final charge is at the weight Delhivery
                measures.
                {estimate.provider === 'mock' && ' Test courier: these are flat test rates, not Delhivery’s.'}
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
