import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Fetching a URL someone else supplied, without letting it reach inside.
//
// A server-side fetch of a user-controlled URL can be pointed at loopback,
// the private network, or a cloud metadata address. This only ever connects
// to public addresses: the address is checked inside the socket's own DNS
// lookup (so a second, different answer cannot slip in between check and
// connect), IP literals are checked directly (the socket skips lookup for
// them), only the default ports are allowed, and every redirect hop is
// checked again from the start.
// ---------------------------------------------------------------------------

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(`Refusing to fetch: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

const NOT_PUBLIC = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 3], // multicast and reserved, through 255.255.255.255
] as const) {
  NOT_PUBLIC.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64: embeds an IPv4 address
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(address, prefix, 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d, or its hex form), if it is one. */
function mappedIpv4(address: string): string | null {
  const v = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True only for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !NOT_PUBLIC.check(address, 'ipv4');
  if (family === 6) {
    const v4 = mappedIpv4(address);
    if (v4) return isPublicAddress(v4);
    return !NOT_PUBLIC.check(address, 'ipv6');
  }
  return false;
}

export interface GuardedFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** Which resolved addresses may be connected to. Tests override this; production never does. */
  isAllowedAddress?: (address: string) => boolean;
  /** Ports allowed besides the scheme's default. Tests only. */
  extraPorts?: number[];
}

/**
 * GET a URL from the public internet and return its body. Throws
 * BlockedUrlError for anything that would leave the public internet, and a
 * plain Error for HTTP failures, timeouts and oversize bodies.
 */
export async function fetchPublic(rawUrl: string, options: GuardedFetchOptions): Promise<Buffer> {
  const allowed = options.isAllowedAddress ?? isPublicAddress;
  const maxRedirects = options.maxRedirects ?? 3;
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const result = await getOnce(url, options, allowed);
    if (result.kind === 'body') return result.body;
    url = new URL(result.location, url).toString();
  }
  throw new Error(`Too many redirects fetching ${rawUrl}`);
}

type Hop = { kind: 'body'; body: Buffer } | { kind: 'redirect'; location: string };

function getOnce(rawUrl: string, options: GuardedFetchOptions, allowed: (a: string) => boolean): Promise<Hop> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.reject(new BlockedUrlError('not a URL'));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new BlockedUrlError(`scheme ${url.protocol}`));
  }
  if (url.username || url.password) return Promise.reject(new BlockedUrlError('credentials in URL'));
  if (url.port && !(options.extraPorts ?? []).includes(Number(url.port))) {
    return Promise.reject(new BlockedUrlError(`port ${url.port}`));
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allowed(host)) return Promise.reject(new BlockedUrlError(`address ${host}`));

  // Check what the name actually resolves to, at connect time.
  const lookup = ((hostname: string, lookupOptions: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      const bad = list.find((a) => !allowed(a.address));
      if (bad || list.length === 0) {
        return callback(new BlockedUrlError(`${hostname} resolves to ${bad?.address ?? 'nothing'}`));
      }
      if (lookupOptions.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as unknown as net.LookupFunction;

  const client = url.protocol === 'https:' ? https : http;
  return new Promise<Hop>((resolve, reject) => {
    const req = client.get(
      url,
      { lookup, timeout: options.timeoutMs, headers: { accept: 'image/*', 'user-agent': 'clowe-fetch/1' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ kind: 'redirect', location: res.headers.location });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} fetching ${url.origin}${url.pathname}`));
          return;
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > options.maxBytes) {
          res.destroy();
          reject(new Error('Response is too large'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            res.destroy();
            reject(new Error('Response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ kind: 'body', body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${url.origin}`)));
    req.on('error', reject);
  });
}
