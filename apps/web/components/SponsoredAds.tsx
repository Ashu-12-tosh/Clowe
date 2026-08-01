'use client';

import { useEffect, useState } from 'react';
import type { ActiveAd, AdPlacementValue } from '@clowe/shared';
import { api } from '@/lib/api';

/** Fire-and-forget ad click beacon. */
export function trackAdClick(adId: string) {
  api(`/api/ads/${adId}/click`, { method: 'POST', body: {} }).catch(() => {});
}

/**
 * Live sponsored ads for a placement. Sponsored products render inline in the
 * normal product grids (via ProductCard's `sponsored` label) — never as a
 * separate block. Pass placement=null to skip fetching.
 */
export function useSponsoredAds(
  placement: AdPlacementValue | null,
  category?: string,
): ActiveAd[] {
  const [ads, setAds] = useState<ActiveAd[]>([]);

  useEffect(() => {
    if (!placement) {
      setAds([]);
      return;
    }
    const qs = new URLSearchParams({ placement });
    if (category) qs.set('category', category);
    api<ActiveAd[]>(`/api/ads/active?${qs.toString()}`)
      .then(setAds)
      .catch(() => setAds([]));
  }, [placement, category]);

  return ads;
}
