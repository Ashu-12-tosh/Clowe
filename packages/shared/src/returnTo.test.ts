import { describe, expect, it } from 'vitest';
import { isReturnablePath, isSignedInOnlyPath, loginCloseTarget } from './returnTo';

describe('isReturnablePath', () => {
  it('accepts public pages, with their query', () => {
    for (const p of ['/', '/products', '/products/blue-tee?size=M', '/category/fashion', '/cart', '/seller/login', '/seller/register']) {
      expect(isReturnablePath(p), p).toBe(true);
    }
  });

  it('refuses pages that need a sign-in, the login page itself, and other sites', () => {
    for (const p of ['/account', '/account/orders/1', '/checkout', '/notifications', '/orders', '/admin', '/seller', '/seller/orders', '/products/blue-tee/tryon', '/login', '//evil.example', 'https://evil.example']) {
      expect(isReturnablePath(p), p).toBe(false);
    }
    expect(isSignedInOnlyPath('/seller/settings')).toBe(true);
  });
});

describe('loginCloseTarget', () => {
  it('steps back when the page before /login is the one to return to', () => {
    expect(loginCloseTarget({ lastPage: '/products/blue-tee', lastReturnable: '/products/blue-tee', historyLength: 3 })).toEqual({ kind: 'back' });
  });

  it('goes home when /login was opened directly', () => {
    expect(loginCloseTarget({ lastPage: null, lastReturnable: null, historyLength: 1 })).toEqual({ kind: 'go', path: '/' });
    expect(loginCloseTarget({ lastPage: null, lastReturnable: null, historyLength: 4 })).toEqual({ kind: 'go', path: '/' });
  });

  it('after a logout from a signed-in page, returns to the last public page instead', () => {
    expect(loginCloseTarget({ lastPage: '/account', lastReturnable: '/products', historyLength: 5 })).toEqual({ kind: 'go', path: '/products' });
  });

  it('goes straight to the page when there is no history to step back through (a new tab)', () => {
    expect(loginCloseTarget({ lastPage: '/cart', lastReturnable: '/cart', historyLength: 1 })).toEqual({ kind: 'go', path: '/cart' });
  });
});
