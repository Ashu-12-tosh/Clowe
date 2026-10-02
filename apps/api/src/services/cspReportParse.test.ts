import { describe, expect, it } from 'vitest';
import { fingerprint, parseCspReports } from './cspReportParse';

describe('parseCspReports', () => {
  it('reads the report-uri format', () => {
    const [v] = parseCspReports({
      'csp-report': {
        'document-uri': 'https://cloweshop.com/products/blue-shirt?utm_source=x&phone=9876543210',
        'violated-directive': 'img-src',
        'effective-directive': 'img-src',
        'blocked-uri': 'https://tracker.example/pixel.gif?id=42',
        disposition: 'report',
      },
    });
    // The page keeps its path only, the blocked source its origin only.
    expect(v).toEqual({
      directive: 'img-src',
      blocked: 'https://tracker.example',
      page: '/products/blue-shirt',
      disposition: 'report',
      sample: null,
    });
  });

  it('reads the Reporting API format, skipping other report types', () => {
    const out = parseCspReports([
      { type: 'deprecation', body: {} },
      {
        type: 'csp-violation',
        url: 'https://cloweshop.com/account/orders/cmtih0c7k0002nkd66rrgaxu6',
        body: {
          documentURL: 'https://cloweshop.com/account/orders/cmtih0c7k0002nkd66rrgaxu6',
          effectiveDirective: 'script-src-elem',
          blockedURL: 'inline',
          disposition: 'enforce',
          sample: 'alert(document.cookie)',
        },
      },
    ]);
    expect(out).toEqual([
      { directive: 'script-src-elem', blocked: 'inline', page: '/account/orders/:id', disposition: 'enforce', sample: 'alert(document.cookie)' },
    ]);
  });

  it('drops what browser extensions inject', () => {
    expect(
      parseCspReports({ 'csp-report': { 'document-uri': 'https://cloweshop.com/', 'violated-directive': 'script-src', 'blocked-uri': 'chrome-extension://abcdef/inject.js' } }),
    ).toEqual([]);
  });

  it('keeps only the scheme of data:, blob: and javascript: sources', () => {
    const [v] = parseCspReports({ 'csp-report': { 'document-uri': 'https://cloweshop.com/', 'violated-directive': 'img-src', 'blocked-uri': 'data:image/png;base64,AAAA' } });
    expect(v.blocked).toBe('data:');
  });

  it('ignores anything that is not a report, and caps a batch', () => {
    expect(parseCspReports(null)).toEqual([]);
    expect(parseCspReports({ hello: 'world' })).toEqual([]);
    const many = Array.from({ length: 50 }, () => ({
      type: 'csp-violation',
      body: { documentURL: 'https://cloweshop.com/', effectiveDirective: 'img-src', blockedURL: 'https://a.example/x' },
    }));
    expect(parseCspReports(many)).toHaveLength(20);
  });

  it('groups by directive, source, page and mode', () => {
    const base = { directive: 'img-src', blocked: 'https://a.example', page: '/', disposition: 'report' as const, sample: null };
    expect(fingerprint(base)).toBe(fingerprint({ ...base, sample: 'different sample' }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, disposition: 'enforce' }));
  });
});
