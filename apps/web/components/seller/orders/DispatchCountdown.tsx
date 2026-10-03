'use client';

import { useEffect, useState } from 'react';
import { dispatchCountdown, type SellerDispatchClock } from '@clowe/shared';

/**
 * Two chips for an order with something left to dispatch: the promise
 * ("Dispatch within 6h 12m") and the penalty ("Penalty after 12h 12m").
 * The deadlines come from the API, vacation pauses included; the client only
 * counts down, ticking once a minute.
 */
export function DispatchCountdown({
  clock,
  className = '',
}: {
  clock: SellerDispatchClock | null;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!clock) return null;
  const view = dispatchCountdown(clock, new Date(now));
  const promiseTone = view.dispatch.late
    ? 'bg-amber-100 text-amber-800'
    : new Date(clock.dispatchBy).getTime() - now < 2 * 3_600_000
      ? 'bg-amber-50 text-amber-800'
      : 'bg-cream-100 text-gray-700';
  const penaltyTone =
    view.penalty?.state === 'DUE' || view.penalty?.state === 'CHARGED'
      ? 'bg-red-100 text-red-700'
      : view.penalty?.state === 'PAUSED'
        ? 'bg-gray-100 text-gray-600'
        : 'bg-white text-gray-600 ring-1 ring-gray-200';
  const chip = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold';

  return (
    <span className={`inline-flex flex-wrap gap-1 ${className}`} data-dispatch-countdown>
      <span className={`${chip} ${promiseTone}`} data-dispatch-promise>
        ⏱ {view.dispatch.label}
      </span>
      {view.penalty && (
        <span className={`${chip} ${penaltyTone}`} data-dispatch-penalty={view.penalty.state}>
          {view.penalty.label}
        </span>
      )}
    </span>
  );
}
