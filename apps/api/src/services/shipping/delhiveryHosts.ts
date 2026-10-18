// Where Delhivery lives, kept apart so env.ts can check a configured URL
// at boot without loading the client.

export type DelhiveryEnvironment = 'staging' | 'production';

export const DELHIVERY_HOSTS: Record<DelhiveryEnvironment, string> = {
  staging: 'https://staging-express.delhivery.com',
  production: 'https://track.delhivery.com',
};

/**
 * Whether `url` is live Delhivery: any delhivery.com host but staging's.
 * Staging (and every test) must never reach one — a live token there books
 * real parcels and spends wallet money.
 */
export function isLiveDelhiveryUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const staging = new URL(DELHIVERY_HOSTS.staging).hostname;
  return host !== staging && (host === 'delhivery.com' || host.endsWith('.delhivery.com'));
}

/** Refuse a staging connection pointed at live Delhivery. */
export function assertStagingIsStaging(environment: DelhiveryEnvironment, baseUrl: string): void {
  if (environment !== 'production' && isLiveDelhiveryUrl(baseUrl)) {
    throw new Error(`Delhivery staging must not use the live URL (${new URL(baseUrl).hostname}) — refusing to start`);
  }
}
