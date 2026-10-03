'use client';

import { useEffect, useState } from 'react';
import type { PublicSettings } from '@clowe/shared';
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
 * The platform return window in days, from settings. Null until it arrives
 * (or if it cannot be read): fillReturnWindow then writes a phrase that is
 * true without a number.
 */
export function useReturnWindowDays(): number | null {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    getPublicSettings()
      .then((s) => alive && setDays(s.returnWindowDays))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return days;
}
