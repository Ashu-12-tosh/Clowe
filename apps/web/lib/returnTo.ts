import { isReturnablePath, loginCloseTarget } from '@clowe/shared';

/** Per tab (sessionStorage): the page before this one, and the last page /login may return to. */
const LAST_KEY = 'clowe.lastPage';
const RETURNABLE_KEY = 'clowe.lastReturnablePage';

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Called on every page change (AppShell). The login page itself is not recorded. */
export function recordPage(path: string): void {
  if (path.split(/[?#]/)[0] === '/login') return;
  try {
    sessionStorage.setItem(LAST_KEY, path);
    if (isReturnablePath(path)) sessionStorage.setItem(RETURNABLE_KEY, path);
  } catch {
    // Storage blocked: closing the login page goes home.
  }
}

/**
 * Leave the login page without signing in: back to where the person came
 * from, or home. Nothing typed is sent — it only navigates.
 */
export function closeLogin(router: { back: () => void; replace: (href: string) => void }): void {
  const target = loginCloseTarget({
    lastPage: read(LAST_KEY),
    lastReturnable: read(RETURNABLE_KEY),
    historyLength: window.history.length,
  });
  if (target.kind === 'back') router.back();
  else router.replace(target.path);
}
