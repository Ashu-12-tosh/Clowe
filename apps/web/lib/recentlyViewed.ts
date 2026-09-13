/**
 * Recently viewed products, remembered in the visitor's own browser.
 *
 * The server also records views (ProductView), but only for signed-in
 * shoppers — the landing page is mostly visited logged out, so the rail there
 * reads this list instead and merges the server history when there is a
 * session. Stores ids only; the cards are fetched from /api/products/by-ids
 * so prices and stock are never stale.
 */
const KEY = 'clowe.recentlyViewed';
const MAX = 20;

/** Product ids, most recently viewed first. Empty when storage is unavailable. */
export function getRecentlyViewedIds(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, MAX);
  } catch {
    return []; // private mode, blocked storage, or corrupt JSON — not worth surfacing
  }
}

/** Move a product to the front of the list. Safe to call on every page view. */
export function recordRecentlyViewed(productId: string): void {
  if (!productId) return;
  try {
    const next = [productId, ...getRecentlyViewedIds().filter((id) => id !== productId)].slice(0, MAX);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Nothing to do — the rail simply stays empty for this visitor.
  }
}
