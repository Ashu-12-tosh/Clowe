const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Read an API resource while rendering a page on the server, so the page's
 * first paint has its content (no skeleton swapped for it, no layout shift).
 * Null when the API cannot be reached or answers with an error: the page then
 * loads it in the browser as before.
 */
export async function serverApi<T>(path: string, revalidateSeconds = 30): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, { next: { revalidate: revalidateSeconds } });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: T }).data ?? null;
  } catch {
    return null;
  }
}
