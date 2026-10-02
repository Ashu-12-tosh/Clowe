import { describe, expect, it } from 'vitest';
import { BlockedUrlError, fetchPublic, isPublicAddress } from './publicFetch';

const OPTS = { timeoutMs: 2_000, maxBytes: 1024 };

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local, metadata, CGNAT, multicast and reserved addresses', () => {
    for (const a of [
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      '64:ff9b::a9fe:a9fe',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it('allows public addresses', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(a), a).toBe(true);
    }
  });
});

describe('fetchPublic refuses before connecting', () => {
  it.each([
    'http://127.0.0.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://10.0.0.5/x',
    'http://localhost/x',
    'http://example.com:8080/x',
    'http://user:pass@example.com/x',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'not a url',
  ])('%s', async (url) => {
    await expect(fetchPublic(url, OPTS)).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
