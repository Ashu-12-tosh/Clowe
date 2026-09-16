/**
 * The last few things this browser searched for.
 *
 * Local to the device on purpose: it is a convenience, not account data, and
 * it should not need a login to work. Every accessor tolerates storage being
 * unavailable — private windows and blocked site data both throw here.
 */
const KEY = 'clowe.recentSearches';
const MAX = 8;

export function getRecentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, MAX);
  } catch {
    return [];
  }
}

/** Move a query to the front, de-duplicated case-insensitively. */
export function recordRecentSearch(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) return;
  try {
    const existing = getRecentSearches().filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
    window.localStorage.setItem(KEY, JSON.stringify([trimmed, ...existing].slice(0, MAX)));
  } catch {
    // Nothing to do — the list simply stays empty for this visitor.
  }
}

export function clearRecentSearches(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Ignored for the same reason.
  }
}
