import { NextResponse, type NextRequest } from 'next/server';
import { buildContentSecurityPolicy } from '@clowe/shared';

/**
 * Content-Security-Policy, with a fresh nonce per page.
 *
 * Next reads the nonce from the policy on the *request* headers and stamps it
 * on every inline script it renders, so the same policy goes on the request
 * (for Next) and the response (for the browser). That only works for pages
 * rendered per request, which is why the root layout is force-dynamic.
 *
 * REPORT-ONLY for now: the browser reports what the policy would block, to
 * /api/csp-reports, and blocks nothing. Flip ENFORCE once a clean run of
 * reports shows the policy fits the site.
 *
 * Reports go by report-uri only. With a report-to group as well, Chrome uses
 * that instead and, measured locally, delivered nothing within 75 seconds,
 * where report-uri arrives at once.
 */
const ENFORCE = false;

const HEADER = ENFORCE ? 'content-security-policy' : 'content-security-policy-report-only';
const dev = process.env.NODE_ENV !== 'production';
const apiOrigin = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').origin;
const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ? new URL(process.env.NEXT_PUBLIC_SITE_URL).origin : null;

function freshNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function middleware(request: NextRequest) {
  const nonce = freshNonce();
  // Behind nginx the request arrives over plain http; the public origin is the configured one.
  const origin = (dev ? null : siteOrigin) ?? request.nextUrl.origin;
  const policy = buildContentSecurityPolicy({
    nonce,
    apiOrigin: apiOrigin === origin ? null : apiOrigin,
    dev,
    reportUri: '/api/csp-reports',
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(HEADER, policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(HEADER, policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API (proxied in dev), uploads, or build assets.
      source: '/((?!api/|uploads/|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
      // Prefetches carry no HTML to protect.
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
