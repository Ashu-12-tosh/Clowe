'use client';

import { useEffect, useState } from 'react';
import { dispatchCountdown, type PublicSettings } from '@clowe/shared';
import { getPublicSettings } from '@/lib/settings';

/**
 * "Dispatch within 4h 12m" / "Late by 2h" for a line that has not shipped.
 * Computed on the client from the order's placement time and the published
 * dispatch window, ticking once a minute, so the chip is right without a
 * round trip per order.
 */
export function DispatchCountdown({ placedAt, className = '' }: { placedAt: string; className?: string }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    getPublicSettings().then(setSettings).catch(() => {});
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!settings) return null;
  const c = dispatchCountdown(new Date(placedAt), new Date(now), settings.dispatchWindowHours);
  const tone = c.late
    ? 'bg-red-100 text-red-700'
    : c.deadline.getTime() - now < 2 * 3_600_000
      ? 'bg-amber-100 text-amber-800'
      : 'bg-cream-100 text-gray-700';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone} ${className}`}
      title={
        settings.penaltyEnabled
          ? `Ship within ${settings.dispatchWindowHours}h of placement to avoid the late-dispatch penalty.`
          : `Ship within ${settings.dispatchWindowHours}h of placement.`
      }
    >
      ⏱ {c.label}
    </span>
  );
}
