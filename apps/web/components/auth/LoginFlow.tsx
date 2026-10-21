'use client';

import { useEffect, useImperativeHandle, useState, type Ref } from 'react';
import Link from 'next/link';
import {
  TERMS_VERSION,
  customerEmailSchema,
  maskPhone,
  parseLoginIdentifier,
  phoneSchema,
  type AccountLookupResult,
  type AuthTokensResponse,
  type OtpRequestResult,
  type PinResetRequestResult,
  type PinResetVerified,
  type SignupPhoneVerified,
} from '@clowe/shared';
import ResendOtp from '@/components/auth/ResendOtp';
import DigitBoxes from '@/components/auth/DigitBoxes';
import { api, ApiRequestError } from '@/lib/api';

// ---------------------------------------------------------------------------
// Login and sign-up, as the owner specified (pre-launch batch 2):
//
//   identify     one box, "Phone number or email" → Continue
//   pin          "Enter your PIN", "Forgot PIN?" on the same screen, and a
//                way back to change the number or email
//   forgot-phone the registered phone number (filled in when they typed a
//                phone) → "Send OTP"; a code goes out only to the account's
//                own number ("This number isn't linked to this account")
//   forgot-code  the code → Verify
//   forgot-pin   "Create new PIN" + "Re-enter new PIN" → Save → signed in;
//                the old PIN works until then
//   signup       no account: name, phone ("Verify" → code below), email, PIN,
//                confirm PIN; "Create account" once the phone is verified and
//                the PINs match
//
// OTP is only ever the sign-up "Verify" and "Forgot PIN?" — never a way to log
// in on its own. The 18+ / Terms line is shown once, on the first screen.
// Used by the shopper login (/login) and the seller login (/seller/login).
// ---------------------------------------------------------------------------

export type LoginStep = 'identify' | 'pin' | 'forgot-phone' | 'forgot-code' | 'forgot-pin' | 'signup' | 'no-account';

export interface LoginFlowHandle {
  /** The "Create Account" switch: the sign-up form, with what was typed. */
  openSignup(): void;
  /** Back to the first screen. */
  backToLogin(): void;
}

const field =
  'h-12 w-full rounded-xl border border-gray-300 bg-white px-3.5 text-base outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-100 sm:text-sm';
const primary =
  'h-12 w-full rounded-xl bg-brand-600 text-sm font-bold uppercase tracking-wide text-white shadow transition hover:bg-brand-700 disabled:opacity-50';
const link = 'font-semibold text-brand-600 hover:underline';

const message = (err: unknown, fallback: string) => (err instanceof ApiRequestError ? err.message : fallback);
const OFFLINE = 'Could not reach Clowe. Check your connection and try again.';

/** Small gold hanger ornament (reference design divider). */
function HangerDivider() {
  return (
    <div className="flex items-center justify-center gap-3">
      <span className="h-px w-16 bg-brand-400/60" />
      <svg width="22" height="16" viewBox="0 0 24 18" fill="none" className="text-brand-600" aria-hidden="true">
        <path
          d="M12 1.5a2.5 2.5 0 0 1 2.5 2.5c0 1.2-.8 1.9-1.5 2.4-.5.4-.8.7-.8 1.1l9.3 6.1c1 .7.5 2.3-.7 2.3H3.2c-1.2 0-1.7-1.6-.7-2.3l9.3-6.1"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <span className="h-px w-16 bg-brand-400/60" />
    </div>
  );
}

/** Dev mode only (mock SMS): the code the API returned. */
function DevCode({ code }: { code: string }) {
  if (!code) return null;
  return (
    <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-center text-xs text-blue-800" data-dev-otp>
      <span className="font-semibold">Dev mode:</span> code <span className="font-mono text-sm font-bold tracking-widest">{code}</span>
    </p>
  );
}

/** "Resend code" for a reset, after the wait the API gave. */
function ResendReset({ first, onResend }: { first: OtpRequestResult; onResend: () => Promise<void> }) {
  const [left, setLeft] = useState(first.resendAfterSec);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return (
    <p className="text-center text-sm text-gray-500">
      Didn&apos;t get it?{' '}
      {left > 0 ? (
        <span>Resend in {left}s</span>
      ) : (
        <button
          type="button"
          disabled={busy}
          className={link}
          onClick={async () => {
            setBusy(true);
            await onResend();
            setBusy(false);
          }}
        >
          Resend OTP
        </button>
      )}
    </p>
  );
}

function Consent() {
  return (
    <p className="text-center text-[11px] leading-relaxed text-gray-500" data-login-consent>
      By continuing you confirm you are 18+ and agree to the{' '}
      <Link href="/pages/terms-conditions" className={link}>
        Terms
      </Link>{' '}
      and{' '}
      <Link href="/pages/privacy-policy" className={link}>
        Privacy Policy
      </Link>
      .
    </p>
  );
}

function BackLink({ onClick, children, action }: { onClick: () => void; children: React.ReactNode; action: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-sm font-semibold text-brand-600 hover:underline" data-action={action}>
      <span aria-hidden="true">←</span> {children}
    </button>
  );
}

export default function LoginFlow({
  variant,
  onSignedIn,
  onStepChange,
  ref,
}: {
  /** The seller login offers shop registration where the shopper login offers sign-up. */
  variant: 'shopper' | 'seller';
  /** Signed in (PIN, new PIN or new account): the page decides where to go. */
  onSignedIn: (data: AuthTokensResponse) => Promise<void> | void;
  onStepChange?: (step: LoginStep) => void;
  ref?: Ref<LoginFlowHandle>;
}) {
  const [step, setStep] = useState<LoginStep>('identify');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // identify / pin
  const [identifier, setIdentifier] = useState('');
  const [account, setAccount] = useState<AccountLookupResult | null>(null);
  const [pin, setPin] = useState('');
  const [locked, setLocked] = useState(false);

  // Forgot PIN (or a first PIN for an account without one)
  const [firstPin, setFirstPin] = useState(false);
  const [resetPhone, setResetPhone] = useState('');
  const [resetSent, setResetSent] = useState<{ sent: PinResetRequestResult; n: number } | null>(null);
  const [resetCode, setResetCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPinAgain, setNewPinAgain] = useState('');

  // signup
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [phoneSent, setPhoneSent] = useState<{ result: OtpRequestResult; n: number } | null>(null);
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneToken, setPhoneToken] = useState('');
  const [verifiedPhone, setVerifiedPhone] = useState('');
  const [signupPin, setSignupPin] = useState('');
  const [signupPinAgain, setSignupPinAgain] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [devOtp, setDevOtp] = useState('');

  useEffect(() => onStepChange?.(step), [step, onStepChange]);

  function go(next: LoginStep) {
    setError('');
    setNotice('');
    setStep(next);
  }

  useImperativeHandle(ref, () => ({
    openSignup() {
      const typed = parseLoginIdentifier(identifier);
      openSignup(typed?.kind === 'email' ? { email: typed.value } : { phone: typed?.value ?? identifier.trim() });
    },
    backToLogin() {
      go('identify');
    },
  }));

  async function signedIn(data: AuthTokensResponse) {
    try {
      await onSignedIn(data);
    } catch (err) {
      setError(message(err, OFFLINE));
      setBusy(false);
    }
  }

  // ---------------- identify ----------------
  async function continueWithIdentifier(e?: React.FormEvent) {
    e?.preventDefault();
    setError('');
    setNotice('');
    const parsed = parseLoginIdentifier(identifier);
    if (!parsed) {
      setError('Enter your 10-digit mobile number or your email address');
      return;
    }
    setBusy(true);
    try {
      const found = await api<AccountLookupResult>('/api/auth/lookup', { body: { identifier } });
      setAccount(found);
      setPin('');
      setLocked(false);
      const what = parsed.kind === 'phone' ? 'number' : 'email';
      if (!found.exists) {
        if (variant === 'seller') {
          go('no-account');
        } else {
          openSignup(parsed.kind === 'phone' ? { phone: parsed.value } : { email: parsed.value });
        }
        setNotice(`No account found with this ${what}`);
      } else if (found.hasPin) {
        go('pin');
      } else {
        startForgot(found, true);
      }
    } catch (err) {
      setError(message(err, OFFLINE));
    } finally {
      setBusy(false);
    }
  }

  // ---------------- pin ----------------
  async function loginWithPin(value: string) {
    if (!account || busy) return;
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/pin-login', {
        body: { identifier: account.identifier, pin: value, termsVersion: TERMS_VERSION },
      });
      await signedIn(data);
    } catch (err) {
      setPin('');
      setLocked(err instanceof ApiRequestError && err.code === 'PIN_LOCKED');
      setError(message(err, OFFLINE));
      setBusy(false);
    }
  }

  // ---------------- forgot PIN ----------------
  function startForgot(target: AccountLookupResult, first = false) {
    setFirstPin(first);
    // Logged in with a phone number: it is filled in. With an email, typed.
    setResetPhone(target.kind === 'phone' ? target.identifier : '');
    setResetSent(null);
    setResetCode('');
    setResetToken('');
    setNewPin('');
    setNewPinAgain('');
    setDevOtp('');
    go('forgot-phone');
  }

  const typedResetPhone = phoneSchema.safeParse(resetPhone);

  async function sendResetCode(e?: React.FormEvent) {
    e?.preventDefault();
    if (!account || busy) return;
    setError('');
    if (!typedResetPhone.success) {
      setError('Enter a valid 10-digit mobile number');
      return;
    }
    setBusy(true);
    try {
      const sent = await api<PinResetRequestResult>('/api/auth/pin-reset/request', {
        body: { identifier: account.identifier, phone: typedResetPhone.data },
      });
      setResetSent((prev) => ({ sent, n: (prev?.n ?? 0) + 1 }));
      setResetCode(sent.devOtp ?? '');
      setDevOtp(sent.devOtp ?? '');
      if (step !== 'forgot-code') go('forgot-code');
    } catch (err) {
      setError(message(err, 'Could not send the OTP. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function verifyResetCode(code: string) {
    if (!account || busy || !typedResetPhone.success) return;
    setError('');
    setBusy(true);
    try {
      const { resetToken: token } = await api<PinResetVerified>('/api/auth/pin-reset/verify', {
        body: { identifier: account.identifier, phone: typedResetPhone.data, code },
      });
      setResetToken(token);
      setDevOtp('');
      go('forgot-pin');
    } catch (err) {
      setResetCode('');
      setError(message(err, 'Could not check the OTP. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  const newPinsDiffer = newPin.length === 4 && newPinAgain.length === 4 && newPin !== newPinAgain;
  const canSaveNewPin = !!resetToken && newPin.length === 4 && newPin === newPinAgain;

  async function saveNewPin(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSaveNewPin || busy) return;
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/pin-reset/confirm', {
        body: { resetToken, pin: newPin, confirmPin: newPinAgain, termsVersion: TERMS_VERSION },
      });
      await signedIn(data);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'RESET_EXPIRED') setResetToken('');
      setError(message(err, 'Could not save your PIN. Please try again.'));
      setBusy(false);
    }
  }

  // ---------------- signup ----------------
  function openSignup(prefill: { phone?: string; email?: string } = {}) {
    setName('');
    setPhone(prefill.phone ?? '');
    setEmail(prefill.email ?? '');
    setPhoneSent(null);
    setPhoneCode('');
    setPhoneToken('');
    setVerifiedPhone('');
    setSignupPin('');
    setSignupPinAgain('');
    setDevOtp('');
    go('signup');
  }

  const typedPhone = phoneSchema.safeParse(phone);
  const phoneVerified = !!phoneToken && typedPhone.success && typedPhone.data === verifiedPhone;
  const emailCheck = email.trim() ? customerEmailSchema.safeParse(email) : null;
  const signupPinsDiffer = signupPin.length === 4 && signupPinAgain.length === 4 && signupPin !== signupPinAgain;
  const canCreate =
    phoneVerified && name.trim().length >= 2 && signupPin.length === 4 && signupPin === signupPinAgain && (!emailCheck || emailCheck.success);

  async function sendPhoneCode() {
    setError('');
    if (!typedPhone.success) {
      setError('Enter a valid 10-digit mobile number');
      return;
    }
    setBusy(true);
    try {
      const result = await api<OtpRequestResult>('/api/auth/request-otp', { body: { phone: typedPhone.data } });
      setPhoneSent((prev) => ({ result, n: (prev?.n ?? 0) + 1 }));
      setPhoneCode(result.devOtp ?? '');
      setDevOtp(result.devOtp ?? '');
    } catch (err) {
      setError(message(err, 'Could not send the OTP. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function verifyPhone(code: string) {
    if (!typedPhone.success || busy) return;
    setError('');
    setBusy(true);
    try {
      const { phoneToken: token } = await api<SignupPhoneVerified>('/api/auth/signup/verify-phone', { body: { phone: typedPhone.data, code } });
      setPhoneToken(token);
      setVerifiedPhone(typedPhone.data);
      setPhoneSent(null);
      setDevOtp('');
    } catch (err) {
      setPhoneCode('');
      setError(message(err, 'Could not verify the OTP. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  function changePhone(value: string) {
    setPhone(value);
    if (phoneToken || phoneSent) {
      // A different number needs its own code.
      setPhoneToken('');
      setVerifiedPhone('');
      setPhoneSent(null);
      setPhoneCode('');
    }
  }

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || busy || !typedPhone.success) return;
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/signup', {
        body: {
          name: name.trim(),
          phone: typedPhone.data,
          phoneToken,
          email: email.trim(),
          pin: signupPin,
          confirmPin: signupPinAgain,
          referralCode: referralCode.trim() || undefined,
          termsVersion: TERMS_VERSION,
        },
      });
      await signedIn(data);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'PHONE_NOT_VERIFIED') {
        setPhoneToken('');
        setVerifiedPhone('');
      }
      setError(message(err, 'Could not create your account. Please try again.'));
      setBusy(false);
    }
  }

  // ---------------- view ----------------
  const who = account ? (account.kind === 'phone' ? maskPhone(account.identifier) : account.identifier) : '';
  const heading: Record<LoginStep, [string, string]> = {
    identify: variant === 'seller' ? ['Seller Login', 'Log in with your seller phone number or email'] : ['Welcome Back', 'Log in or create an account'],
    pin: ['Enter your PIN', who],
    'forgot-phone': [firstPin ? 'Set your PIN' : 'Forgot PIN?', 'Enter the phone number registered with this account'],
    'forgot-code': ['Enter the OTP', `Sent to ${resetSent?.sent.phoneMasked ?? 'your phone'}`],
    'forgot-pin': [firstPin ? 'Create your PIN' : 'Create new PIN', 'Choose a 4-digit PIN you will remember'],
    signup: ['Create Account', 'Verify your phone and choose a 4-digit PIN'],
    'no-account': ['Seller Login', 'Sellers log in with the account their shop is registered to'],
  };
  const [title, subtitle] = heading[step];
  const what = account?.kind === 'email' ? 'email' : 'number';

  return (
    <div data-login-step={step}>
      <h1 className={variant === 'shopper' ? 'text-center font-display text-3xl font-bold text-ink-900' : 'text-3xl font-bold tracking-tight text-brand-900'}>{title}</h1>
      {subtitle && <p className={`mt-1.5 text-sm text-gray-500 ${variant === 'shopper' ? 'text-center' : ''}`}>{subtitle}</p>}
      {variant === 'shopper' && (
        <div className="mt-4">
          <HangerDivider />
        </div>
      )}

      {notice && (
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900" role="status" data-login-notice>
          {notice}
        </div>
      )}
      {error && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert" data-login-error>
          {error}
        </div>
      )}

      {/* ---------------- 1. phone number or email ---------------- */}
      {step === 'identify' && (
        <form className="mt-6 space-y-4" onSubmit={(e) => void continueWithIdentifier(e)} noValidate>
          <div>
            <label htmlFor="login-identifier" className="text-sm font-semibold text-ink-900">
              Phone number or email
            </label>
            <input
              id="login-identifier"
              name="identifier"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="98765 43210 or you@example.com"
              className={`mt-1.5 ${field}`}
              autoFocus
            />
          </div>
          <button type="submit" disabled={busy || !identifier.trim()} className={primary} data-action="continue">
            {busy ? 'Please wait…' : 'Continue'}
          </button>
          <Consent />
        </form>
      )}

      {/* ---------------- 2. PIN ---------------- */}
      {step === 'pin' && account && (
        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void loginWithPin(pin);
          }}
        >
          <DigitBoxes length={4} value={pin} onChange={setPin} masked autoFocus label="PIN" name="pin" onComplete={(v) => void loginWithPin(v)} disabled={busy} />
          <button type="submit" disabled={busy || pin.length !== 4} className={primary} data-action="login">
            {busy ? 'Logging in…' : 'Log in'}
          </button>
          <p className="text-center">
            <button type="button" onClick={() => startForgot(account)} disabled={busy} className={`text-sm ${locked ? 'font-bold' : ''} ${link}`} data-action="forgot-pin">
              Forgot PIN?
            </button>
          </p>
          <p className="text-center">
            <BackLink onClick={() => go('identify')} action="change-identifier">
              Use a different {what}
            </BackLink>
          </p>
        </form>
      )}

      {/* ---------------- Forgot PIN: the registered phone ---------------- */}
      {step === 'forgot-phone' && account && (
        <form className="mt-6 space-y-4" onSubmit={(e) => void sendResetCode(e)} noValidate>
          <div>
            <label htmlFor="reset-phone" className="text-sm font-semibold text-ink-900">
              Registered phone number
            </label>
            <input
              id="reset-phone"
              name="reset-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              value={resetPhone}
              onChange={(e) => setResetPhone(e.target.value)}
              placeholder="10-digit mobile number"
              className={`mt-1.5 ${field}`}
              autoFocus={!resetPhone}
            />
          </div>
          <button type="submit" disabled={busy || !typedResetPhone.success} className={primary} data-action="send-reset-otp">
            {busy ? 'Sending…' : 'Send OTP'}
          </button>
          {!firstPin && <p className="text-center text-xs text-gray-500">Your current PIN keeps working until you save a new one.</p>}
          <p className="text-center">
            <BackLink onClick={() => go(firstPin ? 'identify' : 'pin')} action="back">
              Back
            </BackLink>
          </p>
        </form>
      )}

      {/* ---------------- Forgot PIN: the code ---------------- */}
      {step === 'forgot-code' && account && resetSent && (
        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void verifyResetCode(resetCode);
          }}
        >
          <DevCode code={devOtp} />
          <DigitBoxes length={6} value={resetCode} onChange={setResetCode} autoFocus label="OTP" name="reset-code" oneTimeCode onComplete={(v) => void verifyResetCode(v)} disabled={busy} />
          <button type="submit" disabled={busy || resetCode.length !== 6} className={primary} data-action="verify-reset-otp">
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <ResendReset key={resetSent.n} first={resetSent.sent} onResend={() => sendResetCode()} />
          <p className="text-center">
            <BackLink onClick={() => go('forgot-phone')} action="change-reset-phone">
              Change number
            </BackLink>
          </p>
        </form>
      )}

      {/* ---------------- Forgot PIN: the new PIN ---------------- */}
      {step === 'forgot-pin' && account && (
        <form className="mt-6 space-y-5" onSubmit={(e) => void saveNewPin(e)}>
          <div>
            <p className="mb-2 text-center text-sm font-semibold text-ink-900">{firstPin ? 'Create PIN' : 'Create new PIN'}</p>
            <DigitBoxes length={4} value={newPin} onChange={setNewPin} masked autoFocus label={firstPin ? 'Create PIN' : 'Create new PIN'} name="new-pin" />
          </div>
          <div>
            <p className="mb-2 text-center text-sm font-semibold text-ink-900">{firstPin ? 'Re-enter PIN' : 'Re-enter new PIN'}</p>
            <DigitBoxes length={4} value={newPinAgain} onChange={setNewPinAgain} masked label={firstPin ? 'Re-enter PIN' : 'Re-enter new PIN'} name="new-pin-again" />
            {newPinsDiffer && <p className="mt-2 text-center text-xs font-medium text-red-600">The two PINs don&apos;t match</p>}
          </div>
          <button type="submit" disabled={busy || !canSaveNewPin} className={primary} data-action="save-pin">
            {busy ? 'Saving…' : 'Save'}
          </button>
          {!resetToken && (
            <p className="text-center">
              <button type="button" onClick={() => startForgot(account, firstPin)} className={`text-sm ${link}`}>
                Start again
              </button>
            </p>
          )}
          {!firstPin && <p className="text-center text-xs text-gray-500">Saving signs you out on your other devices.</p>}
        </form>
      )}

      {/* ---------------- seller login: no account ---------------- */}
      {step === 'no-account' && (
        <div className="mt-6 space-y-4">
          <Link
            href="/seller/register"
            className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700"
            data-action="register-shop"
          >
            Register your shop →
          </Link>
          <p className="text-center">
            <BackLink onClick={() => go('identify')} action="change-identifier">
              Use a different number or email
            </BackLink>
          </p>
        </div>
      )}

      {/* ---------------- no account: create one ---------------- */}
      {step === 'signup' && (
        <form className="mt-6 space-y-4" onSubmit={(e) => void createAccount(e)} noValidate>
          <div>
            <label htmlFor="signup-name" className="text-sm font-semibold text-ink-900">
              Name
            </label>
            <input id="signup-name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={`mt-1.5 ${field}`} placeholder="Your full name" />
          </div>

          <div>
            <label htmlFor="signup-phone" className="text-sm font-semibold text-ink-900">
              Phone
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="signup-phone"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                value={phone}
                onChange={(e) => changePhone(e.target.value)}
                className={`${field} min-w-0 flex-1`}
                placeholder="10-digit mobile number"
              />
              {phoneVerified ? (
                <span className="flex h-12 shrink-0 items-center rounded-xl bg-green-50 px-3 text-sm font-bold text-green-700" data-phone-verified>
                  ✓ Verified
                </span>
              ) : phoneSent ? (
                // Sent: the code box and its own "Resend" (with the wait) are just below.
                <span className="flex h-12 shrink-0 items-center px-2 text-xs font-semibold text-gray-500">OTP sent</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void sendPhoneCode()}
                  disabled={busy || !typedPhone.success}
                  className="h-12 shrink-0 rounded-xl border-2 border-brand-600 px-4 text-sm font-bold text-brand-600 hover:bg-brand-50 disabled:opacity-50"
                  data-action="verify-phone"
                >
                  Verify
                </button>
              )}
            </div>
            {phoneSent && !phoneVerified && (
              <div className="mt-3 space-y-3 rounded-xl border border-gray-100 bg-cream-50 p-3" data-phone-otp>
                <p className="text-center text-xs text-gray-600">
                  Enter the OTP sent to <span className="font-semibold">{typedPhone.success ? maskPhone(typedPhone.data) : phone}</span>
                </p>
                <DevCode code={devOtp} />
                <DigitBoxes length={6} value={phoneCode} onChange={setPhoneCode} autoFocus label="Phone OTP" name="phone-code" oneTimeCode onComplete={(v) => void verifyPhone(v)} disabled={busy} />
                <button type="button" onClick={() => void verifyPhone(phoneCode)} disabled={busy || phoneCode.length !== 6} className={primary} data-action="confirm-phone">
                  {busy ? 'Checking…' : 'Verify OTP'}
                </button>
                {typedPhone.success && (
                  <ResendOtp
                    key={phoneSent.n}
                    phone={typedPhone.data}
                    firstSent={phoneSent.result}
                    onSent={(r) => {
                      setDevOtp(r.devOtp ?? '');
                      setPhoneCode(r.devOtp ?? '');
                    }}
                  />
                )}
              </div>
            )}
          </div>

          <div>
            <label htmlFor="signup-email" className="text-sm font-semibold text-ink-900">
              Email <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              id="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`mt-1.5 ${field}`}
              placeholder="you@example.com"
            />
            {emailCheck && !emailCheck.success && <p className="mt-1 text-xs text-red-600">{emailCheck.error.issues[0]?.message}</p>}
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-ink-900">PIN</p>
            <DigitBoxes length={4} value={signupPin} onChange={setSignupPin} masked label="PIN" name="signup-pin" />
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-ink-900">Confirm PIN</p>
            <DigitBoxes length={4} value={signupPinAgain} onChange={setSignupPinAgain} masked label="Confirm PIN" name="signup-pin-again" />
            {signupPinsDiffer && <p className="mt-2 text-center text-xs font-medium text-red-600">The two PINs don&apos;t match</p>}
          </div>

          <details className="text-sm text-gray-500">
            <summary className="cursor-pointer select-none">Have a referral code?</summary>
            <input value={referralCode} onChange={(e) => setReferralCode(e.target.value.toUpperCase())} placeholder="Referral code (optional)" className={`mt-2 ${field}`} />
          </details>

          <button type="submit" disabled={busy || !canCreate} className={primary} data-action="create-account">
            {busy ? 'Creating…' : 'Create account'}
          </button>
          {!phoneVerified && <p className="text-center text-xs text-gray-500">Verify your phone number to create your account.</p>}
        </form>
      )}
    </div>
  );
}
