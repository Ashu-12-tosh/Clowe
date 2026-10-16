import { setFunctional } from '@/lib/cookieConsent';

/**
 * How this device last signed in: PIN or OTP. Only the device remembers it;
 * the pages never ask the server whether a number has an account or a PIN.
 */
export type LoginMethod = 'otp' | 'pin';
const LOGIN_METHOD_KEY = 'clowe.loginMethod';

/** The method this device used last, or null when it hasn't signed in here. */
export function lastLoginMethod(): LoginMethod | null {
  try {
    const v = localStorage.getItem(LOGIN_METHOD_KEY);
    return v === 'pin' || v === 'otp' ? v : null;
  } catch {
    return null;
  }
}

export function rememberLoginMethod(method: LoginMethod): void {
  try {
    setFunctional(LOGIN_METHOD_KEY, method);
  } catch {
    // Storage blocked (private window): the choice just isn't remembered.
  }
}
