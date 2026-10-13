'use client';

import { useEffect, useState } from 'react';
import type { UnreadNotifications } from '@clowe/shared';
import { api, getStoredUser } from './api';

/** Fired after a cart / wishlist / notification write so every badge re-reads at once. */
export const BADGES_EVENT = 'clowe:refresh-badges';

/** How often a visible tab asks whether a notification has arrived. */
export const NOTIFICATION_POLL_MS = 5_000;

/**
 * The signed-in user's unread notifications, kept current: checked every few
 * seconds while the tab is visible, and at once when the tab comes back into
 * view or a badge event fires. A hidden tab does not poll. Null until the
 * first answer, and while signed out.
 */
export function useUnreadNotifications(): UnreadNotifications | null {
  const [state, setState] = useState<UnreadNotifications | null>(null);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const check = () => {
      if (stopped || inFlight || document.visibilityState !== 'visible') return;
      if (!getStoredUser()) {
        setState(null);
        return;
      }
      inFlight = true;
      api<UnreadNotifications>('/api/notifications/unread', { auth: true })
        .then((next) => {
          if (stopped) return;
          // Same answer, same object: no re-render every five seconds.
          setState((prev) =>
            prev && prev.unreadCount === next.unreadCount && prev.latestAt === next.latestAt ? prev : next,
          );
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };

    check();
    const timer = setInterval(check, NOTIFICATION_POLL_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener(BADGES_EVENT, check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener(BADGES_EVENT, check);
    };
  }, []);

  return state;
}
