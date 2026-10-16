import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allows,
  CONSENT_MAX_AGE_SECONDS,
  consentCookie,
  readConsent,
  saveConsent,
  setFunctional,
} from './cookieConsent';

// A browser-like document cookie jar and localStorage.
let jar: string;
let store: Map<string, string>;

beforeEach(() => {
  jar = '';
  store = new Map();
  vi.stubGlobal('document', {
    get cookie() {
      return jar;
    },
    set cookie(v: string) {
      jar = v.split(';')[0]!;
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal('window', { dispatchEvent: () => true });
  vi.stubGlobal('CustomEvent', class {});
});
afterEach(() => vi.unstubAllGlobals());

describe('cookie consent (Cookie Policy 4)', () => {
  it('allows nothing optional before a choice', () => {
    expect(readConsent()).toBeNull();
    expect(allows('functional')).toBe(false);
    setFunctional('clowe.pincode', '110073');
    expect(store.has('clowe.pincode')).toBe(false);
  });

  it('records the choice for 12 months', () => {
    expect(CONSENT_MAX_AGE_SECONDS).toBe(365 * 24 * 60 * 60);
    expect(consentCookie({ functional: true, analytics: false, advertising: false })).toMatch(/Max-Age=31536000; Path=\/; SameSite=Lax$/);
  });

  it('functional storage works once accepted', () => {
    saveConsent({ functional: true, analytics: false, advertising: false });
    expect(allows('functional')).toBe(true);
    expect(allows('analytics')).toBe(false);
    setFunctional('clowe.pincode', '110073');
    expect(store.get('clowe.pincode')).toBe('110073');
  });

  it('refusing clears what functional storage held', () => {
    store.set('clowe.pincode', '110073');
    store.set('clowe.recentlyViewed', '[]');
    store.set('clowe.accessToken', 'session'); // strictly necessary: untouched
    saveConsent({ functional: false, analytics: false, advertising: false });
    expect(store.has('clowe.pincode')).toBe(false);
    expect(store.has('clowe.recentlyViewed')).toBe(false);
    expect(store.get('clowe.accessToken')).toBe('session');
  });

  it('asks again when the categories change (version)', () => {
    jar = `clowe_consent=${encodeURIComponent(JSON.stringify({ v: 0, functional: true }))}`;
    expect(readConsent()).toBeNull();
  });
});
