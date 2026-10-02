import { z } from 'zod';

// ---------------------------------------------------------------------------
// Stored links: the one allow-list.
//
// A URL someone else typed is only ever rendered as a link or an image if it
// is an absolute http(s) URL or a path on this site. Every other scheme is
// refused: `javascript:`, `data:` and `vbscript:` can run script when the
// link is followed, and zod's `.url()` accepts all of them (it is
// `new URL()` and nothing more), so it must not be used for these fields.
//
// The same predicates back the write-time schemas below and the render-time
// check in the web app, so a value can only reach a page through both.
// ---------------------------------------------------------------------------

/** Whitespace and control characters: browsers strip some of them inside URLs, which turns "/\t/host" into "//host". */
const UNSAFE_CHARS = /[\u0000- \u007f-\u009f]/;

/** An absolute http:// or https:// URL with a host. */
export function isHttpUrl(value: string): boolean {
  if (UNSAFE_CHARS.test(value) || !/^https?:\/\/[^/?#\\]/i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * A path on this site: one leading slash. Never "//host" or "/\host", which
 * browsers resolve to another origin.
 */
export function isAppPath(value: string): boolean {
  return !UNSAFE_CHARS.test(value) && /^\/(?![/\\])/.test(value) && !value.includes('\\');
}

/** The value, if it is safe to put in an href or src; otherwise null. */
export function safeHref(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return isHttpUrl(v) || isAppPath(v) ? v : null;
}

/** An absolute http(s) URL (an outside link: a website, a social profile). */
export function httpUrlSchema(max = 2048) {
  return z
    .string()
    .trim()
    .max(max)
    .refine(isHttpUrl, { message: 'Enter a full link starting with https://' });
}

/** A link that may point inside the site ("/products") or outside it. */
export function linkHrefSchema(max = 2048) {
  return z
    .string()
    .trim()
    .max(max)
    .refine((v) => isHttpUrl(v) || isAppPath(v), {
      message: 'Enter a path starting with / or a full link starting with https://',
    });
}
