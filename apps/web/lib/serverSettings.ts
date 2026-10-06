import type { PublicSettings } from '@clowe/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Public settings for a server-rendered page (policies, Contact Us), cached
 * for a minute. Null when the API cannot be reached: each page then falls
 * back to what it can say without them rather than failing.
 */
export async function serverPublicSettings(): Promise<Partial<PublicSettings> | null> {
  try {
    const res = await fetch(`${API_URL}/api/settings/public`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Partial<PublicSettings> };
    return json.data ?? null;
  } catch {
    return null;
  }
}
