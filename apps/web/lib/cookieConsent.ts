/**
 * Cookie consent (Cookie Policy 2 and 4). Strictly necessary storage — sign-in,
 * session, cart — is always on. Functional, analytics and advertising storage
 * happens only once accepted. The choice itself is kept in a first-party
 * cookie for 12 months, then the banner asks again.
 *
 * Clowe loads no analytics or advertising scripts today; those categories are
 * offered so a choice exists before anything of the kind is ever added, and
 * anything added must check `allows()` before it loads.
 */

export const CONSENT_COOKIE = 'clowe_consent';
/** Bump when the categories change, so everyone is asked again. */
export const CONSENT_VERSION = 1;
export const CONSENT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60; // 12 months

export type ConsentCategory = 'functional' | 'analytics' | 'advertising';
export interface ConsentChoice {
  functional: boolean;
  analytics: boolean;
  advertising: boolean;
}

/** Storage keys that are functional (Cookie Policy 2.2): cleared when functional consent is refused. */
export const FUNCTIONAL_KEYS = [
  'clowe.pincode',
  'clowe.recentlyViewed',
  'clowe.recentSearches',
  'clowe.loginMethod',
  'clowe.labelSize',
];

export const CONSENT_EVENT = 'clowe:consent';
export const OPEN_SETTINGS_EVENT = 'clowe:cookie-settings';

/** The stored choice, or null when none has been made (or it has expired / is outdated). */
export function readConsent(cookie: string = typeof document === 'undefined' ? '' : document.cookie): ConsentChoice | null {
  const raw = cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${CONSENT_COOKIE}=`));
  if (!raw) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw.slice(CONSENT_COOKIE.length + 1))) as Partial<ConsentChoice> & { v?: number };
    if (value.v !== CONSENT_VERSION) return null;
    return { functional: !!value.functional, analytics: !!value.analytics, advertising: !!value.advertising };
  } catch {
    return null;
  }
}

/** The cookie string that records a choice for 12 months. */
export function consentCookie(choice: ConsentChoice): string {
  const value = encodeURIComponent(JSON.stringify({ v: CONSENT_VERSION, ...choice, at: new Date().toISOString() }));
  return `${CONSENT_COOKIE}=${value}; Max-Age=${CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
}

export function saveConsent(choice: ConsentChoice): void {
  document.cookie = consentCookie(choice);
  if (!choice.functional) {
    try {
      for (const key of FUNCTIONAL_KEYS) localStorage.removeItem(key);
    } catch {
      // Storage blocked: nothing to clear.
    }
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: choice }));
}

/** Whether a category may be used now. Nothing optional before a choice. */
export function allows(category: ConsentCategory): boolean {
  if (typeof document === 'undefined') return false;
  return readConsent()?.[category] ?? false;
}

/** Write functional storage only with consent (Cookie Policy 2.2). */
export function setFunctional(key: string, value: string): void {
  if (!allows('functional')) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: a convenience, not needed.
  }
}

/** The footer's "Cookie Settings" link. */
export function openCookieSettings(): void {
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}
