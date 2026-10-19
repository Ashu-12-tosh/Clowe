'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import LoginBackdrop from '@/components/LoginBackdrop';
import LegalCopyright from '@/components/LegalCopyright';
import ResendOtp from '@/components/auth/ResendOtp';
import DigitBoxes from '@/components/auth/DigitBoxes';
import { closeLogin } from '@/lib/returnTo';
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
  type SignupPhoneVerified,
  type UserRole,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser, saveSession } from '@/lib/api';

// ---------------------------------------------------------------------------
// Login and sign-up (owner's redesign, pre-launch audit 2026-10-20 D1).
//
//   identify  one box, "Phone number or email" → Continue
//   pin       an account with a PIN: the PIN, "Forgot PIN?"
//   reset     a code to the account's phone + the new PIN, sent together
//             (also how an account without a PIN sets its first one)
//   signup    no account: name, phone ("Verify" → code below → verified),
//             email, PIN, confirm PIN; "Create account" only when the phone
//             is verified and the PINs match
//
// The number and email are normalised exactly as the API stores them
// (+91 / 0 / spaces, case), and nothing is cut while typing.
// ---------------------------------------------------------------------------

type Step = 'identify' | 'pin' | 'reset' | 'signup';

const field =
  'h-12 w-full rounded-xl border border-gray-300 bg-white px-3.5 text-base outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-100 sm:text-sm';
const primary =
  'h-12 w-full rounded-xl bg-brand-600 text-sm font-bold uppercase tracking-wide text-white shadow transition hover:bg-brand-700 disabled:opacity-50';
const link = 'font-semibold text-brand-600 hover:underline';

/** Admin/seller land on their dashboard; customers go straight to the home page. */
function dashboardFor(role: UserRole): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'SELLER') return '/seller';
  return '/';
}

const message = (err: unknown, fallback: string) => (err instanceof ApiRequestError ? err.message : fallback);

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

/** Dev mode only (mock SMS): the code the API returned, shown as the old page did. */
function DevCode({ code }: { code: string }) {
  if (!code) return null;
  return (
    <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-center text-xs text-blue-800" data-dev-otp>
      <span className="font-semibold">Dev mode:</span> code <span className="font-mono text-sm font-bold tracking-widest">{code}</span>
    </p>
  );
}

/** "Resend code" for a reset, whose phone the page may know only masked. */
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
          Resend code
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

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('identify');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // identify / pin
  const [identifier, setIdentifier] = useState('');
  const [account, setAccount] = useState<AccountLookupResult | null>(null);
  const [pin, setPin] = useState('');
  const [locked, setLocked] = useState(false);

  // reset ("Forgot PIN?", or a first PIN)
  const [reset, setReset] = useState<{ sent: PinResetRequestResult; n: number; firstPin: boolean } | null>(null);
  const [resetCode, setResetCode] = useState('');
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

  // Already signed in: this page is for signing in only.
  useEffect(() => {
    if (getStoredUser()) router.replace('/account');
  }, [router]);

  // Esc leaves the login page (nothing typed is sent), like the X and the back arrow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLogin(router);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  function go(next: Step) {
    setError('');
    setNotice('');
    setStep(next);
  }

  function finish(data: AuthTokensResponse) {
    saveSession(data);
    router.push(dashboardFor(data.user.role));
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
      if (!found.exists) {
        openSignup(parsed.kind === 'phone' ? { phone: parsed.value } : { email: parsed.value });
        setNotice(`No account found with this ${parsed.kind === 'phone' ? 'number' : 'email'} — create one`);
      } else if (found.hasPin) {
        go('pin');
      } else {
        await startReset(found, true);
      }
    } catch (err) {
      setError(message(err, 'Could not reach Clowe. Check your connection and try again.'));
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
      finish(data);
    } catch (err) {
      setPin('');
      setLocked(err instanceof ApiRequestError && err.code === 'PIN_LOCKED');
      setError(message(err, 'Could not reach Clowe. Check your connection and try again.'));
      setBusy(false);
    }
  }

  // ---------------- reset ----------------
  async function startReset(target: AccountLookupResult, firstPin = false) {
    setError('');
    setBusy(true);
    try {
      const sent = await api<PinResetRequestResult>('/api/auth/pin-reset/request', { body: { identifier: target.identifier } });
      setReset((prev) => ({ sent, n: (prev?.n ?? 0) + 1, firstPin }));
      setResetCode(sent.devOtp ?? '');
      setDevOtp(sent.devOtp ?? '');
      setNewPin('');
      setNewPinAgain('');
      go('reset');
    } catch (err) {
      setError(message(err, 'Could not send the code. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  const newPinsDiffer = newPin.length === 4 && newPinAgain.length === 4 && newPin !== newPinAgain;
  const canReset = resetCode.length === 6 && newPin.length === 4 && newPin === newPinAgain;

  async function confirmReset(e?: React.FormEvent) {
    e?.preventDefault();
    if (!account || !canReset || busy) return;
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/pin-reset/confirm', {
        body: { identifier: account.identifier, code: resetCode, pin: newPin, confirmPin: newPinAgain, termsVersion: TERMS_VERSION },
      });
      finish(data);
    } catch (err) {
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
      setError(message(err, 'Could not send the code. Please try again.'));
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
      setError(message(err, 'Could not verify the code. Please try again.'));
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
      finish(data);
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
  const title = step === 'signup' ? 'Create Account' : step === 'reset' ? (reset?.firstPin ? 'Set Your PIN' : 'Reset Your PIN') : 'Welcome Back';
  const subtitle =
    step === 'signup'
      ? 'Verify your phone and choose a 4-digit PIN'
      : step === 'reset'
        ? `Enter the code we sent to ${reset?.sent.phoneMasked ?? 'your phone'} and choose a new PIN`
        : step === 'pin'
          ? 'Enter your 4-digit PIN'
          : 'Log in or create an account';

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* ============ LEFT: brand panel ============ */}
      <aside className="sticky top-0 hidden h-screen shrink-0 bg-black lg:block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/login-panel.jpg" alt="Clowe — Your Style, Our Intelligence" className="h-full w-auto select-none" draggable={false} />
      </aside>

      {/* ============ RIGHT: auth card over the blurred storefront ============ */}
      <main className="relative flex flex-1 flex-col bg-cream-50">
        <LoginBackdrop />

        {/* Mobile compact brand header */}
        <div className="relative z-10 bg-ink-950 px-5 py-4 text-center lg:hidden">
          <button
            type="button"
            onClick={() => closeLogin(router)}
            aria-label="Back"
            data-login-back
            className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-2xl leading-none text-brand-400 hover:bg-white/10"
          >
            ←
          </button>
          <span className="font-display text-xl font-bold uppercase tracking-[0.25em] text-brand-400">Clowe</span>
          <p className="mt-0.5 text-[11px] text-brand-400/80">Your Style, Our Intelligence.</p>
        </div>

        {/* Top-right switch */}
        <div className="relative z-10 flex items-center justify-end gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
          <span className="hidden text-sm text-gray-500 sm:inline">{step === 'signup' ? 'Already have an account?' : 'New to Clowe?'}</span>
          <button
            type="button"
            onClick={() => (step === 'signup' ? go('identify') : openSignup(parseLoginIdentifier(identifier)?.kind === 'email' ? { email: identifier.trim() } : { phone: identifier.trim() }))}
            className="rounded-lg border-2 border-brand-600 px-4 py-1.5 text-sm font-bold text-brand-600 hover:bg-brand-50"
            data-login-switch
          >
            {step === 'signup' ? 'Log in' : 'Create Account'}
          </button>
        </div>

        <div className="relative z-10 flex flex-1 items-start justify-center px-4 py-5 sm:items-center sm:py-10">
          <div className="relative w-full max-w-md rounded-3xl border border-gray-100 bg-white p-5 shadow-xl sm:p-9" data-login-step={step}>
            <button
              type="button"
              onClick={() => closeLogin(router)}
              aria-label="Close"
              title="Close (Esc)"
              data-login-close
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none text-gray-400 hover:bg-gray-100 hover:text-ink-900"
            >
              ✕
            </button>
            <h1 className="text-center font-display text-3xl font-bold text-ink-900">{title}</h1>
            <p className="mt-1.5 text-center text-sm text-gray-500">{subtitle}</p>
            <div className="mt-4">
              <HangerDivider />
            </div>

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

            {/* ---------------- identify ---------------- */}
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

            {/* ---------------- pin ---------------- */}
            {step === 'pin' && account && (
              <form
                className="mt-6 space-y-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loginWithPin(pin);
                }}
              >
                <p className="text-center text-sm text-gray-600">
                  <span className="font-semibold">{who}</span>{' '}
                  <button type="button" onClick={() => go('identify')} className={link}>
                    Change
                  </button>
                </p>
                <DigitBoxes length={4} value={pin} onChange={setPin} masked autoFocus label="PIN" name="pin" onComplete={(v) => void loginWithPin(v)} disabled={busy} />
                <button type="submit" disabled={busy || pin.length !== 4} className={primary} data-action="login">
                  {busy ? 'Logging in…' : 'Log in'}
                </button>
                <p className="text-center">
                  <button type="button" onClick={() => void startReset(account)} disabled={busy} className={`text-sm ${locked ? 'font-bold' : ''} ${link}`} data-action="forgot-pin">
                    Forgot PIN?
                  </button>
                </p>
              </form>
            )}

            {/* ---------------- reset ---------------- */}
            {step === 'reset' && account && reset && (
              <form className="mt-6 space-y-5" onSubmit={(e) => void confirmReset(e)}>
                <p className="text-center text-sm text-gray-600">
                  For <span className="font-semibold">{who}</span>{' '}
                  <button type="button" onClick={() => go('identify')} className={link}>
                    Change
                  </button>
                </p>
                <DevCode code={devOtp} />
                <div>
                  <p className="mb-2 text-center text-sm font-semibold text-ink-900">Code from SMS</p>
                  <DigitBoxes length={6} value={resetCode} onChange={setResetCode} autoFocus label="Code" name="reset-code" oneTimeCode />
                </div>
                <ResendReset key={reset.n} first={reset.sent} onResend={() => startReset(account, reset.firstPin)} />
                <div>
                  <p className="mb-2 text-center text-sm font-semibold text-ink-900">New 4-digit PIN</p>
                  <DigitBoxes length={4} value={newPin} onChange={setNewPin} masked label="New PIN" name="new-pin" />
                </div>
                <div>
                  <p className="mb-2 text-center text-sm font-semibold text-ink-900">Enter it again</p>
                  <DigitBoxes length={4} value={newPinAgain} onChange={setNewPinAgain} masked label="Confirm PIN" name="new-pin-again" />
                  {newPinsDiffer && <p className="mt-2 text-center text-xs font-medium text-red-600">The two PINs don&apos;t match</p>}
                </div>
                <button type="submit" disabled={busy || !canReset} className={primary} data-action="save-pin">
                  {busy ? 'Saving…' : 'Save PIN & log in'}
                </button>
                {!reset.firstPin && (
                  <p className="text-center text-xs text-gray-500">Your old PIN keeps working until you save the new one. Saving signs you out on other devices.</p>
                )}
              </form>
            )}

            {/* ---------------- signup ---------------- */}
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
                      <span className="flex h-12 shrink-0 items-center px-2 text-xs font-semibold text-gray-500">Code sent</span>
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
                        Enter the code sent to <span className="font-semibold">{typedPhone.success ? maskPhone(typedPhone.data) : phone}</span>
                      </p>
                      <DevCode code={devOtp} />
                      <DigitBoxes length={6} value={phoneCode} onChange={setPhoneCode} autoFocus label="Phone code" name="phone-code" oneTimeCode onComplete={(v) => void verifyPhone(v)} disabled={busy} />
                      <button type="button" onClick={() => void verifyPhone(phoneCode)} disabled={busy || phoneCode.length !== 6} className={primary} data-action="confirm-phone">
                        {busy ? 'Checking…' : 'Verify code'}
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
                <Consent />
              </form>
            )}
          </div>
        </div>

        <LegalCopyright className="pb-5 text-center text-xs text-gray-400" />
      </main>
    </div>
  );
}
