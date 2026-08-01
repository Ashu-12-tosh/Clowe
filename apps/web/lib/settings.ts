import type { PublicSettings } from '@clowe/shared';
import { api } from './api';

let cache: Promise<PublicSettings> | null = null;

/** Public platform settings (try-on threshold, social links) — cached per page load. */
export function getPublicSettings(): Promise<PublicSettings> {
  cache ??= api<PublicSettings>('/api/settings/public').catch((err) => {
    cache = null; // allow retry on failure
    throw err;
  });
  return cache;
}
