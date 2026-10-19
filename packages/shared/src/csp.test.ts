import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, DEMO_IMAGE_ORIGINS } from './csp';

const directive = (policy: string, name: string) =>
  policy
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `))
    ?.split(' ')
    .slice(1) ?? null;

describe('buildContentSecurityPolicy', () => {
  const prod = buildContentSecurityPolicy({ nonce: 'abc123==', reportUri: '/api/csp-reports' });

  it('allows scripts only by nonce, never inline or eval in production', () => {
    const scripts = directive(prod, 'script-src')!;
    expect(scripts).toContain("'nonce-abc123=='");
    expect(scripts).toContain("'strict-dynamic'");
    // 'unsafe-inline' here would also re-allow javascript: URLs.
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(directive(prod, 'default-src')).toEqual(["'self'"]);
  });

  it('cannot be framed, and plugins and base-tag hijacks are off', () => {
    expect(directive(prod, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(prod, 'object-src')).toEqual(["'none'"]);
    expect(directive(prod, 'base-uri')).toEqual(["'self'"]);
    // Forms post only to the site itself and to the payment gateway's bank pages.
    expect(directive(prod, 'form-action')).toEqual(["'self'", 'https://*.cashfree.com']);
  });

  it('lets media play from data: URLs (the seller’s video preview) and blob:', () => {
    expect(directive(prod, 'media-src')).toEqual(expect.arrayContaining(["'self'", 'blob:', 'data:']));
  });

  it('reports to the endpoint it is given', () => {
    expect(directive(prod, 'report-uri')).toEqual(['/api/csp-reports']);
  });

  it('carries the demo image hosts until the demo catalog goes', () => {
    for (const origin of DEMO_IMAGE_ORIGINS) expect(directive(prod, 'img-src')).toContain(origin);
  });

  it('adds the API origin and the dev-only allowances only when asked', () => {
    const dev = buildContentSecurityPolicy({ nonce: 'n', apiOrigin: 'http://localhost:4400', dev: true });
    expect(directive(dev, 'connect-src')).toEqual(["'self'", 'http://localhost:4400', 'https://*.cashfree.com', 'ws:', 'wss:']);
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(prod, 'connect-src')).toEqual(["'self'", 'https://*.cashfree.com']);
  });

  it('lets the Cashfree checkout load, frame and call its own hosts — and nothing wider', () => {
    expect(directive(prod, 'script-src')).toContain('https://sdk.cashfree.com');
    expect(directive(prod, 'frame-src')).toContain('https://*.cashfree.com');
    for (const name of ['script-src', 'frame-src', 'connect-src', 'form-action']) {
      for (const value of directive(prod, name)!) expect(value).not.toMatch(/^(https?:)?\*|^https:\/\/\*\.com$/);
    }
  });
});
