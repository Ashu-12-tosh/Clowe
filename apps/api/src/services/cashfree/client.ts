import { constants, createHash, createHmac, publicEncrypt, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

/**
 * What every Cashfree product shares: which host to call, and how to sign a
 * request for two-factor authentication.
 *
 * Verification is the first product on this account; payments and payouts are
 * meant to follow. They sit under different paths (/verification, /pg,
 * /payout) with separate API keys, but the same host per environment and the
 * same signature scheme — so this file is the part they can all use, and each
 * product keeps its own client beside it. Each product also has its own
 * environment setting: verification can be live while payouts are in sandbox.
 */

export type CashfreeEnvironment = 'sandbox' | 'production';

/** Sandbox never bills; production does. */
export function cashfreeHost(environment: CashfreeEnvironment): string {
  return environment === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
}

/**
 * The x-cf-signature header, for accounts using public-key 2FA instead of an
 * IP allowlist: `clientId.unixSeconds`, RSA-OAEP (SHA-1) encrypted with the
 * public key Cashfree issued, base64. Valid for a few minutes, so it is made
 * per request rather than cached.
 */
export function cashfreeSignature(clientId: string, publicKeyPem: string, now = Date.now()): string {
  const plaintext = `${clientId}.${Math.floor(now / 1000)}`;
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(plaintext),
  ).toString('base64');
}

/**
 * A PEM key as it survives an env file: on one line, with literal "\n" where
 * the line breaks were. Real newlines are left alone.
 */
export function pemFromEnv(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

/**
 * fetch, but over IPv4 only. Cashfree's IP allowlist (Payouts and the
 * verification suite in production) takes IPv4 addresses alone, so a request
 * that left the server over IPv6 would be refused even from the allowlisted
 * machine. Enough of fetch for these clients: method, headers, a string body,
 * an abort signal, and a Response back.
 */
export const ipv4Fetch: typeof fetch = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'https:') {
      reject(new Error('ipv4Fetch: https only'));
      return;
    }
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (body !== undefined && !headers.has('content-length')) headers.set('content-length', String(Buffer.byteLength(body)));
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        family: 4,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') responseHeaders.set(k, v);
            else if (Array.isArray(v)) responseHeaders.set(k, v.join(', '));
          }
          // A Response cannot carry a body on these statuses.
          const empty = status === 204 || status === 304;
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
        });
        res.on('error', reject);
      },
    );
    const onAbort = () => req.destroy(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    if (body !== undefined) req.write(body);
    req.end();
  });

/**
 * A stable x-idempotency-key for one operation: the same seed (our order,
 * refund or transfer id) always gives the same UUID, so a retry after a
 * timeout is recognised by Cashfree as the request it already has.
 */
export function idempotencyKey(seed: string): string {
  const h = createHash('sha256').update(`clowe:${seed}`).digest('hex');
  // Shaped as a version-4 UUID (Cashfree validates the format).
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * A Cashfree webhook's signature: base64 HMAC-SHA256 of the x-webhook-timestamp
 * header followed directly by the raw body, keyed with the product's client
 * secret — the gateway's for payment webhooks, the payouts' for transfer ones.
 * Always over the raw bytes: a re-serialised body would not match.
 */
export function verifyCashfreeWebhook(rawBody: Buffer, timestamp: string, signature: string, secret: string): boolean {
  if (!timestamp || !signature) return false;
  const expected = createHmac('sha256', secret).update(timestamp).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rupees as Cashfree wants them (a number, two decimals) from paise. */
export function rupeesFromPaise(paise: number): number {
  return Math.round(paise) / 100;
}

/** Paise from an amount Cashfree returned (number or numeric string), or NaN. */
export function paiseFromRupees(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Cashfree's error code from a JSON error body, or ''. */
export function cashfreeErrorCode(body: unknown): string {
  return body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
    ? (body as { code: string }).code
    : '';
}
