import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Content-Security-Policy violation reports.
//
// Browsers send them in two shapes: the older report-uri body
// ({"csp-report": {...}}, application/csp-report) and the Reporting API
// (an array of {type: "csp-violation", body: {...}}, application/reports+json).
// Both are reduced to the same four fields and grouped, so a page that trips
// the policy a million times is one row with a count.
//
// Nothing personal is kept: the page is reduced to its path (no query string,
// ids collapsed), and the blocked resource to its origin or scheme.
// ---------------------------------------------------------------------------

/** One POST may batch several reports; more than this is not a browser. */
const MAX_PER_REQUEST = 20;

export interface CspViolation {
  directive: string;
  blocked: string;
  page: string;
  disposition: 'report' | 'enforce';
  sample: string | null;
}

/** Sources a browser extension injects; they say nothing about the site. */
const EXTENSION_SCHEMES = /^(chrome|moz|safari|safari-web|ms-browser)-extension:/i;
/** Database ids in a path (cuid), so /account/orders/<id> is one page, not one per order. */
const ID_SEGMENT = /^c[a-z0-9]{20,}$/i;

const clip = (value: string, max: number) => value.slice(0, max);

function pagePath(raw: unknown): string {
  if (typeof raw !== 'string') return '(unknown)';
  try {
    const { pathname } = new URL(raw);
    return clip(
      pathname
        .split('/')
        .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
        .join('/'),
      200,
    );
  } catch {
    return '(unknown)';
  }
}

function blockedSource(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return 'inline';
  if (EXTENSION_SCHEMES.test(raw)) return null;
  // Keywords browsers use instead of a URL.
  if (/^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink|self)$/i.test(raw)) return raw.toLowerCase();
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:') {
      return url.origin;
    }
    return url.protocol; // data:, blob:, javascript: …
  } catch {
    return clip(raw, 60);
  }
}

function directiveName(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '(unknown)';
  return clip(raw.trim().split(/\s+/)[0], 40);
}

function toViolation(fields: {
  page: unknown;
  directive: unknown;
  blocked: unknown;
  disposition: unknown;
  sample: unknown;
}): CspViolation | null {
  const blocked = blockedSource(fields.blocked);
  if (blocked === null) return null;
  return {
    directive: directiveName(fields.directive),
    blocked,
    page: pagePath(fields.page),
    disposition: fields.disposition === 'enforce' ? 'enforce' : 'report',
    sample: typeof fields.sample === 'string' && fields.sample ? clip(fields.sample, 80) : null,
  };
}

/** Reduce a report POST body, in either format, to violations worth keeping. */
export function parseCspReports(body: unknown): CspViolation[] {
  const out: CspViolation[] = [];
  if (Array.isArray(body)) {
    for (const report of body.slice(0, MAX_PER_REQUEST)) {
      if (!report || typeof report !== 'object' || (report as { type?: unknown }).type !== 'csp-violation') continue;
      const b = ((report as { body?: unknown }).body ?? {}) as Record<string, unknown>;
      const v = toViolation({
        page: b.documentURL ?? (report as { url?: unknown }).url,
        directive: b.effectiveDirective,
        blocked: b.blockedURL,
        disposition: b.disposition,
        sample: b.sample,
      });
      if (v) out.push(v);
    }
  } else if (body && typeof body === 'object' && 'csp-report' in body) {
    const r = ((body as Record<string, unknown>)['csp-report'] ?? {}) as Record<string, unknown>;
    const v = toViolation({
      page: r['document-uri'],
      directive: r['effective-directive'] ?? r['violated-directive'],
      blocked: r['blocked-uri'],
      disposition: r.disposition,
      sample: r['script-sample'],
    });
    if (v) out.push(v);
  }
  return out;
}

export function fingerprint(v: CspViolation): string {
  return createHash('sha256').update([v.directive, v.blocked, v.page, v.disposition].join('\n')).digest('hex');
}
