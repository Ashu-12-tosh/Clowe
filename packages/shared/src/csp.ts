// ---------------------------------------------------------------------------
// The storefront's Content-Security-Policy.
//
// Built per request with a fresh nonce: Next stamps the nonce on its own
// inline scripts, and 'strict-dynamic' lets those scripts load the rest
// (route chunks, the Razorpay checkout script). There is deliberately no
// 'unsafe-inline' in script-src: that would also re-allow javascript: URLs,
// which is the main thing this policy exists to stop.
//
// Every origin the site loads from is listed here and nowhere else.
// ---------------------------------------------------------------------------

/**
 * Demo catalog image hosts. TEMPORARY: production still shows the seeded
 * demo products, whose images are hot-linked from these. Remove them when the
 * demo catalog is removed at launch.
 */
export const DEMO_IMAGE_ORIGINS = ['https://loremflickr.com', 'https://picsum.photos', 'https://fastly.picsum.photos'];

/** Private files are served through short-lived R2 signed URLs, which only work on the S3 endpoint host. */
export const PRIVATE_FILE_ORIGINS = ['https://*.r2.cloudflarestorage.com'];

/** Razorpay Checkout: its script (inserted by our code) and the iframe it opens. */
export const PAYMENT_SCRIPT_ORIGINS = ['https://checkout.razorpay.com'];
export const PAYMENT_FRAME_ORIGINS = ['https://api.razorpay.com', 'https://checkout.razorpay.com'];

export interface CspOptions {
  /** A fresh base64 value per response. */
  nonce: string;
  /** The API's origin when it is not the page's own (development). Same-origin in production. */
  apiOrigin?: string | null;
  /** Public image delivery origin (the image CDN), once there is one. */
  imageOrigins?: string[];
  /** next dev needs eval for fast refresh and a websocket for HMR. Never in production. */
  dev?: boolean;
  /** Where browsers POST violation reports (report-uri). */
  reportUri?: string;
}

export function buildContentSecurityPolicy(o: CspOptions): string {
  const api = o.apiOrigin ? [o.apiOrigin] : [];
  const images = o.imageOrigins ?? [];
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", ...PAYMENT_SCRIPT_ORIGINS, ...(o.dev ? ["'unsafe-eval'"] : [])],
    ],
    // React style props render as style attributes; there is no nonce for those.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', ...api, ...images, ...PRIVATE_FILE_ORIGINS, ...DEMO_IMAGE_ORIGINS]],
    ['media-src', ["'self'", 'blob:', ...api, ...PRIVATE_FILE_ORIGINS]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...api, ...(o.dev ? ['ws:', 'wss:'] : [])]],
    ['frame-src', PAYMENT_FRAME_ORIGINS],
    ['worker-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  if (o.reportUri) directives.push(['report-uri', [o.reportUri]]);
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** One grouped violation, as the admin CSP report page lists it. */
export interface CspReportRow {
  id: string;
  directive: string;
  blocked: string;
  page: string;
  disposition: 'report' | 'enforce';
  sample: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
