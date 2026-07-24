'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getStoredUser } from '@/lib/api';
import { addToWishlist, removeFromWishlist } from '@/lib/wishlist';

interface Props {
  productId: string;
  initialInWishlist: boolean;
  /** 'icon' = heart overlay on cards; 'button' = full button on detail page. */
  variant?: 'icon' | 'button';
  onRemoved?: () => void;
}

export default function WishlistButton({
  productId,
  initialInWishlist,
  variant = 'icon',
  onRemoved,
}: Props) {
  const router = useRouter();
  const [inWishlist, setInWishlist] = useState(initialInWishlist);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!getStoredUser()) {
      router.push('/login');
      return;
    }
    setBusy(true);
    try {
      if (inWishlist) {
        await removeFromWishlist(productId);
        setInWishlist(false);
        onRemoved?.();
      } else {
        await addToWishlist(productId);
        setInWishlist(true);
      }
    } finally {
      setBusy(false);
    }
  }

  if (variant === 'button') {
    return (
      <button
        onClick={() => void toggle()}
        disabled={busy}
        className={`rounded-lg border px-5 py-2.5 text-sm font-semibold transition ${
          inWishlist
            ? 'border-brand-600 bg-brand-100 text-brand-600'
            : 'border-gray-300 text-gray-700 hover:border-brand-600 hover:text-brand-600'
        }`}
      >
        {inWishlist ? '♥ Wishlisted' : '♡ Wishlist'}
      </button>
    );
  }

  return (
    <button
      onClick={(e) => {
        e.preventDefault(); // card is wrapped in a Link
        void toggle();
      }}
      disabled={busy}
      aria-label={inWishlist ? 'Remove from wishlist' : 'Add to wishlist'}
      className={`absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-lg shadow transition ${
        inWishlist ? 'text-brand-600' : 'text-gray-400 hover:text-brand-600'
      }`}
    >
      {inWishlist ? '♥' : '♡'}
    </button>
  );
}
