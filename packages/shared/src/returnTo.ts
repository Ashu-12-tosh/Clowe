// ---------------------------------------------------------------------------
// Leaving the login page without signing in (the X, Esc, the back arrow).
// It returns to the page the person came from — the last page they could see
// without an account — or home when /login was opened directly. A page that
// needs a sign-in is never the destination: it would only send them back to
// /login (that is where a logout leaves someone).
// ---------------------------------------------------------------------------

/** Pages that send a signed-out visitor to /login. */
const SIGNED_IN_ONLY = [/^\/account(\/|$)/, /^\/checkout(\/|$)/, /^\/notifications(\/|$)/, /^\/orders(\/|$)/, /^\/admin(\/|$)/, /^\/seller(?!\/(login|register)(\/|$))(\/|$)/, /^\/products\/[^/]+\/tryon(\/|$)/];

export function isSignedInOnlyPath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0]!;
  return SIGNED_IN_ONLY.some((re) => re.test(pathname));
}

/** Whether a page is one the login page can return to. */
export function isReturnablePath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0]!;
  return pathname.startsWith('/') && !pathname.startsWith('//') && pathname !== '/login' && !isSignedInOnlyPath(pathname);
}

/**
 * Where closing the login page goes. `back` when the page right before /login
 * in this tab is the one to return to — a real history step, so the browser's
 * back button and the X agree; otherwise straight to the last returnable page,
 * or home.
 */
export function loginCloseTarget(input: {
  /** The page visited just before /login in this tab, if any. */
  lastPage: string | null;
  /** The last page in this tab that is returnable. */
  lastReturnable: string | null;
  /** window.history.length */
  historyLength: number;
}): { kind: 'back' } | { kind: 'go'; path: string } {
  const { lastPage, lastReturnable, historyLength } = input;
  if (lastPage && lastPage === lastReturnable && historyLength > 1) return { kind: 'back' };
  return { kind: 'go', path: lastReturnable && isReturnablePath(lastReturnable) ? lastReturnable : '/' };
}
