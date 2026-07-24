'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';

interface Props {
  variantId: string | null; // null until a size is picked
  stock: number;
}

export default function AddToCartButton({ variantId, stock }: Props) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'added'>('idle');
  const [error, setError] = useState('');

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
      setState('added');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setState('idle');
    }
  }

  if (state === 'added') {
    return (
      <Link
        href="/cart"
        className="flex-1 rounded-lg bg-green-600 py-2.5 text-center text-sm font-semibold text-white hover:bg-green-700"
      >
        ✓ Added — Go to Cart
      </Link>
    );
  }

  return (
    <div className="flex-1">
      <button
        onClick={() => void add()}
        disabled={state === 'busy' || stock === 0 || !variantId}
        className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {stock === 0 ? 'Out of stock' : state === 'busy' ? 'Adding…' : 'Add to Cart'}
      </button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
