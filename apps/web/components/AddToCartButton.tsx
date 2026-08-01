'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { UserRole } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';

interface Props {
  variantId: string | null; // null until a size is picked
  stock: number;
  /** 'cart' = black Add to Cart; 'buy' = gold-outlined Buy Now (adds + goes to checkout). */
  mode?: 'cart' | 'buy';
}

export default function AddToCartButton({ variantId, stock, mode = 'cart' }: Props) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'added'>('idle');
  const [error, setError] = useState('');
  // Sellers/admins browse the store view-only (in useEffect — avoids hydration mismatch).
  const [role, setRole] = useState<UserRole | null>(null);
  useEffect(() => setRole(getStoredUser()?.role ?? null), []);

  if (role === 'SELLER' || role === 'ADMIN') {
    if (mode === 'buy') return null; // one notice is enough — shown on the cart-mode slot
    return (
      <div className="flex-1">
        <div className="w-full rounded-lg border border-gray-200 bg-cream-100 py-3 text-center text-sm font-semibold text-gray-500">
          👁 View only — {role === 'SELLER' ? 'seller' : 'admin'} accounts can&apos;t purchase
        </div>
      </div>
    );
  }

  async function add() {
    if (!getStoredUser()) {
      router.push('/login');
      return;
    }
    if (!variantId) return;
    setError('');
    setState('busy');
    try {
      await api('/api/cart/items', { body: { variantId, quantity: 1 }, auth: true });
      if (mode === 'buy') {
        router.push('/checkout');
        return;
      }
      setState('added');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setState('idle');
    }
  }

  if (mode === 'cart' && state === 'added') {
    return (
      <Link
        href="/cart"
        className="flex-1 rounded-lg bg-green-600 py-3 text-center text-sm font-bold uppercase tracking-wide text-white hover:bg-green-700"
      >
        ✓ Added — Go to Cart
      </Link>
    );
  }

  const styles =
    mode === 'cart'
      ? 'bg-ink-900 text-white hover:bg-ink-800'
      : 'border-2 border-brand-600 text-brand-600 hover:bg-brand-50';

  return (
    <div className="flex-1">
      <button
        onClick={() => void add()}
        disabled={state === 'busy' || stock === 0 || !variantId}
        className={`w-full rounded-lg py-3 text-sm font-bold uppercase tracking-wide transition disabled:opacity-50 ${styles}`}
      >
        {stock === 0
          ? 'Out of stock'
          : state === 'busy'
            ? 'Please wait…'
            : mode === 'cart'
              ? 'Add to Cart'
              : 'Buy Now'}
      </button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
