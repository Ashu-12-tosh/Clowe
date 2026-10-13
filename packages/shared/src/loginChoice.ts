// ---------------------------------------------------------------------------
// The login method choice, as rules both login pages follow. The pages offer
// "Login with PIN" and "Get OTP" for every number and never ask the server
// whether a number has an account or a PIN (the #6 enumeration fix).
// ---------------------------------------------------------------------------

export type LoginMethodValue = 'pin' | 'otp';

/** Only "Login with PIN" is ever preselected: on a device last signed in with a PIN. */
export function preselectedLoginMethod(lastUsedOnDevice: LoginMethodValue | null): LoginMethodValue | null {
  return lastUsedOnDevice === 'pin' ? 'pin' : null;
}

/**
 * What Enter in the number field does. Signing in, it is the preselected PIN
 * step or nothing at all — an OTP is sent only when someone chooses it. A new
 * account (sign-up) has no PIN yet, so it starts with an OTP.
 */
export function phoneSubmitAction(input: {
  signup: boolean;
  phoneComplete: boolean;
  preselected: LoginMethodValue | null;
}): 'pin' | 'otp' | 'none' {
  if (!input.phoneComplete) return 'none';
  if (input.signup) return 'otp';
  return input.preselected === 'pin' ? 'pin' : 'none';
}
