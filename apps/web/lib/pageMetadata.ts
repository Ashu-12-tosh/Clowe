const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/** A meta description: one line, at most ~155 characters, cut at a word. */
export function metaDescription(text: string | null | undefined, fallback: string): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  if (clean.length <= 155) return clean;
  return `${clean.slice(0, 155).replace(/\s+\S*$/, '')}…`;
}

/**
 * Read one API resource for a page's <title> and description. Server-side,
 * cached for five minutes, and flagged so the API does not count it as a
 * product view. Null when the API cannot be reached or the thing is gone —
 * the page then keeps the site's default title.
 */
export async function metaFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { 'x-clowe-metadata': '1' },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: T }).data ?? null;
  } catch {
    return null;
  }
}

