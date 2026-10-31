// ---------------------------------------------------------------------------
// The key for one checkout attempt in this tab. Sent with every Place order /
// Pay, so a retry after a lost answer gets the same order back from the
// server rather than a second one. It is forgotten once that order is paid or
// cannot be paid any more; the next checkout gets a new one. The server also
// recognises the same cart from another tab without it.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'clowe.checkoutKey';

function fresh(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let memory: string | null = null;

export function checkoutKey(): string {
  try {
    const kept = sessionStorage.getItem(STORAGE_KEY);
    if (kept) return kept;
    const made = fresh();
    sessionStorage.setItem(STORAGE_KEY, made);
    return made;
  } catch {
    // Storage blocked (private mode, a preview): one key for this page's life.
    memory ??= fresh();
    return memory;
  }
}

export function forgetCheckoutKey(): void {
  memory = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
