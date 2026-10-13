import { describe, expect, it } from 'vitest';
import { phoneSubmitAction, preselectedLoginMethod } from './loginChoice';

describe('preselectedLoginMethod', () => {
  it('preselects "Login with PIN" only on a device last signed in with a PIN', () => {
    expect(preselectedLoginMethod('pin')).toBe('pin');
    expect(preselectedLoginMethod('otp')).toBeNull();
    expect(preselectedLoginMethod(null)).toBeNull();
  });
});

describe('phoneSubmitAction (Enter in the number field)', () => {
  it('never sends an OTP when signing in: the PIN step if preselected, else nothing', () => {
    expect(phoneSubmitAction({ signup: false, phoneComplete: true, preselected: 'pin' })).toBe('pin');
    expect(phoneSubmitAction({ signup: false, phoneComplete: true, preselected: null })).toBe('none');
    expect(phoneSubmitAction({ signup: false, phoneComplete: true, preselected: 'otp' })).toBe('none');
  });

  it('starts a new account with an OTP (there is no PIN yet)', () => {
    expect(phoneSubmitAction({ signup: true, phoneComplete: true, preselected: 'pin' })).toBe('otp');
  });

  it('does nothing until the number is complete', () => {
    expect(phoneSubmitAction({ signup: false, phoneComplete: false, preselected: 'pin' })).toBe('none');
    expect(phoneSubmitAction({ signup: true, phoneComplete: false, preselected: null })).toBe('none');
  });
});
