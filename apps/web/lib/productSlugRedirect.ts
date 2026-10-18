/**
 * /products/<old slug>[/rest] → the same path on the current slug, query
 * kept, or null when the slug is not an old one.
 */
export function renamedProductPath(pathname: string, map: Record<string, string>): string | null {
  const match = /^\/products\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const current = map[slug];
  return current && current !== slug ? `/products/${encodeURIComponent(current)}${match[2] ?? ''}` : null;
}
