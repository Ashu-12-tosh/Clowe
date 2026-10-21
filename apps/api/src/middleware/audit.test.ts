import { describe, expect, it } from 'vitest';
import { redactUrl } from './audit';

describe('redactUrl', () => {
  it('replaces credential values in the query and keeps everything else', () => {
    expect(redactUrl('/api/webhooks/delhivery?token=s3cret')).toBe('/api/webhooks/delhivery?token=[redacted]');
    expect(redactUrl('/api/x?page=2&Token=abc&sort=asc')).toBe('/api/x?page=2&Token=[redacted]&sort=asc');
    expect(redactUrl('/api/x?api_key=1&signature=2&otp=3&pin=4&password=5')).toBe(
      '/api/x?api_key=[redacted]&signature=[redacted]&otp=[redacted]&pin=[redacted]&password=[redacted]',
    );
    expect(redactUrl('/api/x?%74oken=abc')).toBe('/api/x?%74oken=[redacted]');
  });

  it('leaves a URL without a query, or without credentials, as it was', () => {
    expect(redactUrl('/api/seller/orders/abc')).toBe('/api/seller/orders/abc');
    expect(redactUrl('/api/x?q=token&tokenish=1')).toBe('/api/x?q=token&tokenish=1');
    expect(redactUrl('/api/x?token')).toBe('/api/x?token');
  });
});
