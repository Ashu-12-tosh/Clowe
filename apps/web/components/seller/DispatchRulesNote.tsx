'use client';

import { useEffect, useState } from 'react';
import { fillPolicyText, type PublicSettings } from '@clowe/shared';
import { getPublicSettings } from '@/lib/settings';

/**
 * The platform's dispatch rules in a sentence, from settings: the promise
 * every seller is held to and when the penalty falls due. Sellers no longer
 * set a promise of their own.
 */
export function DispatchRulesNote({ className = '' }: { className?: string }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  useEffect(() => {
    getPublicSettings().then(setSettings).catch(() => {});
  }, []);
  const penalty = settings && !settings.penaltyEnabled ? '' : ' An order not dispatched within {{penaltyAfter}} is charged {{penaltyAmount}}, once; vacation mode pauses that clock.';
  return (
    <p className={`break-words text-xs text-gray-600 ${className}`} data-dispatch-rules>
      {fillPolicyText(`Dispatch within {{dispatchSla}} of each order, set by Clowe for every store.${penalty}`, settings)}
    </p>
  );
}
