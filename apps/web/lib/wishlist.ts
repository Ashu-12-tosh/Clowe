'use client';

import type { WishlistEntry } from '@clowe/shared';
import { api, getStoredUser } from './api';

/** Product ids in the current user's wishlist; empty set when logged out. */
export async function fetchWishlistIds(): Promise<Set<string>> {
  if (!getStoredUser()) return new Set();
  try {
    const items = await api<WishlistEntry[]>('/api/wishlist', { auth: true });
    return new Set(items.map((i) => i.productId));
  } catch {
    return new Set();
  }
}

export async function addToWishlist(productId: string): Promise<void> {
  await api(`/api/wishlist/${productId}`, { method: 'POST', auth: true });
}

export async function removeFromWishlist(productId: string): Promise<void> {
  await api(`/api/wishlist/${productId}`, { method: 'DELETE', auth: true });
}
