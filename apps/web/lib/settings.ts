import type { PublicSettings } from '@clowe/shared';
import { api } from './api';

let cache: Promise<PublicSettings> | null = null;

const CHANGED = 'clowe:public-settings-changed';
/** Carries the change to the site's other open tabs in this browser. */
const channel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANGED) : null;
channel?.addEventListener('message', () => {
  cache = null;
  window.dispatchEvent(new Event(CHANGED));
});

/** Public platform settings (try-on threshold, social links) — cached per page load. */
export function getPublicSettings(): Promise<PublicSettings> {
  cache ??= api<PublicSettings>('/api/settings/public').catch((err) => {
    cache = null; // allow retry on failure
    throw err;
  });
  return cache;
}

/**
 * After an admin save: drop the cached copy, here and in the other open tabs,
 * and tell mounted components (footer, copyright line) to read again.
 */
export function publicSettingsChanged(): void {
  cache = null;
  window.dispatchEvent(new Event(CHANGED));
  channel?.postMessage('changed');
}

/** Runs `listener` whenever the public settings change; returns the unsubscribe. */
export function onPublicSettingsChanged(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}
