'use client';

import { useEffect, useState } from 'react';
import { getPublicSettings } from './settings';

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
