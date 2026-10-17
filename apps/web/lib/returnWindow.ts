'use client';

import { useEffect, useState } from 'react';
import { CLAIM_WINDOW_HOURS, type PublicSettings } from '@clowe/shared';
import { getPublicSettings } from './settings';

/**
 * Public settings for filling policy copy (fillPolicyText): the return
 * window and the dispatch rules. Null until they arrive.
 */
export function usePolicySettings(): PublicSettings | null {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  useEffect(() => {
    let alive = true;
    getPublicSettings()
      .then((s) => alive && setSettings(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return settings;
}

/**
 * Hours after delivery to claim a damaged, wrong or defective item, from
 * settings (the policy's own figure until they arrive). There are no
 * change-of-mind returns.
 */
export function useClaimWindowHours(): number {
  const [hours, setHours] = useState<number>(CLAIM_WINDOW_HOURS);
  useEffect(() => {
    let alive = true;
    getPublicSettings()
      .then((s) => alive && s.claimWindowHours && setHours(s.claimWindowHours))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return hours;
}
