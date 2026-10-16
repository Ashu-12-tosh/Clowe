'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import LoginBackdrop from '@/components/LoginBackdrop';
import LegalCopyright from '@/components/LegalCopyright';
import ResendOtp from '@/components/auth/ResendOtp';
import LoginMethodChoice from '@/components/auth/LoginMethodChoice';
import { lastLoginMethod, rememberLoginMethod as rememberMethod, type LoginMethod } from '@/lib/loginMethod';
import { closeLogin } from '@/lib/returnTo';
import { TERMS_VERSION, phoneSubmitAction, preselectedLoginMethod, type AuthTokensResponse, type AuthUser, type OtpRequestResult, type UserRole } from '@clowe/shared';
import {
  api,
  ApiRequestError,
  getStoredUser,
  saveSession,
  setStoredUser,
  uploadPrivateImages,
} from '@/lib/api';
import { TryOnConsentBox, useTryOnConsent } from '@/components/TryOnConsent';

type Step = 'phone' | 'pin' | 'otp' | 'profile' | 'photo' | 'setpin' | 'newpin';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600';

/** Admin/seller land on their dashboard; customers go straight to the home page. */
function dashboardFor(role: UserRole): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'SELLER') return '/seller';
  return '/';
}


function maskedPhone(phone: string): string {
  return `+91 ${phone.slice(0, 2)}XXX XX${phone.slice(7)}`;
}

/** Small gold hanger ornament (reference design divider). */
function HangerDivider() {
  return (
    <div className="flex items-center justify-center gap-3">
      <span className="h-px w-16 bg-brand-400/60" />
      <svg width="22" height="16" viewBox="0 0 24 18" fill="none" className="text-brand-600">
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

/**
 * Individual digit boxes (PIN/OTP): numeric keyboard, auto-advance,
 * backspace navigation, paste support.
 */
function DigitBoxes({
  length,
  value,
  onChange,
  masked = false,
  autoFocus = false,
  onComplete,
}: {
  length: number;
  value: string;
  onChange: (v: string) => void;
  masked?: boolean;
  autoFocus?: boolean;
  onComplete?: (v: string) => void;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  function commit(next: string) {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
  }

  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type={masked ? 'password' : 'tel'}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          autoFocus={autoFocus && i === 0}
          value={value[i] ?? ''}
          onChange={(e) => {
            const digit = e.target.value.replace(/\D/g, '').slice(-1);
            const next = value.slice(0, i) + digit + value.slice(i + 1);
            commit(next);
            if (digit && i < length - 1) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData('text');
            commit(pasted);
            refs.current[Math.min(pasted.replace(/\D/g, '').length, length - 1)]?.focus();
          }}
          className="h-12 w-11 rounded-xl border border-gray-300 bg-white text-center text-lg font-bold text-ink-900 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-100"
        />
      ))}
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  /** "Forgot PIN?": the OTP about to be checked resets the PIN. */
  const [pinReset, setPinReset] = useState(false);
  /** The new PIN, typed a second time. */
  const [pinConfirm, setPinConfirm] = useState('');
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
  /** "Login with PIN" is preselected on a device last signed in with a PIN; nothing else is. */
  const [preselected, setPreselected] = useState<LoginMethod | null>(null);
  useEffect(() => setPreselected(preselectedLoginMethod(lastLoginMethod())), []);
  /** A PIN login failed: offer OTP right there. */
  const [pinFailed, setPinFailed] = useState(false);
  /** Which choice is working on the phone step. */
  const [choosing, setChoosing] = useState<LoginMethod | null>(null);
  const [code, setCode] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [devOtp, setDevOtp] = useState('');
  const [signupMode, setSignupMode] = useState(false);
  // The request that sent the code on screen; a new one restarts the resend countdown.
  const [otpSent, setOtpSent] = useState<{ result: OtpRequestResult; n: number } | null>(null);

  // Onboarding (new users only)
  const [name, setName] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [pincode, setPincode] = useState('');
  const [altPhone, setAltPhone] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const consent = useTryOnConsent();
  const [photoPreview, setPhotoPreview] = useState('');

  // Already logged in? This page is auth-only — send them to their account.
  useEffect(() => {
    if (getStoredUser()) router.replace('/account');
  }, [router]);


  useEffect(() => {
    if (!photoFile) return;
    const url = URL.createObjectURL(photoFile);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  /** After any successful auth: new user → onboarding; no PIN → offer one; else dashboard. */
  function finishAuth(data: AuthTokensResponse, method: LoginMethod) {
    saveSession(data);
    if (!data.pinResetRequired) rememberMethod(method);
    setUser(data.user);
    setError('');
    setNotice('');
    if (data.pinResetRequired) {
      // The old PIN is already gone; a new one is set before going in.
      setPin('');
      setPinConfirm('');
      setStep('newpin');
    } else if (data.isNewUser) setStep('profile');
    else if (!data.user.hasPin) setStep('setpin');
    else router.push(dashboardFor(data.user.role));
  }

  async function sendOtp(message?: string) {
    setError('');
    setBusy(true);
    try {
      const data = await api<OtpRequestResult>('/api/auth/request-otp', {
        body: { phone },
      });
      if (data.devOtp) {
        setDevOtp(data.devOtp);
        setCode(data.devOtp);
      } else {
        setCode('');
      }
      if (message) setNotice(message);
      setOtpSent((prev) => ({ result: data, n: (prev?.n ?? 0) + 1 }));
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Enter in the number field: on a device last signed in with a PIN, that is
   * the PIN step; otherwise nothing — no OTP goes out until it is chosen. A new
   * account (sign-up) always starts with an OTP.
   */
  async function submitPhone() {
    setNotice('');
    const action = phoneSubmitAction({ signup: signupMode, phoneComplete: phone.length === 10, preselected });
    if (action === 'otp') await chooseOtp();
    else if (action === 'pin') choosePin();
  }

  function choosePin() {
    setError('');
    setNotice('');
    setPinFailed(false);
    setPin('');
    setStep('pin');
  }

  async function chooseOtp() {
    setPinReset(false);
    setPinFailed(false);
    setChoosing('otp');
    await sendOtp();
    setChoosing(null);
  }

  /** "Forgot PIN?": an OTP, then a new PIN — the old one stops working once the code is verified. */
  async function forgotPin() {
    setPinReset(true);
    await sendOtp('Enter the code we sent. Then you’ll choose a new PIN — your old PIN stops working.');
  }

  async function loginWithPin(pinValue: string) {
    setError('');
    setBusy(true);
    try {
      setPinFailed(false);
      const data = await api<AuthTokensResponse>('/api/auth/pin-login', {
        body: { phone, pin: pinValue, termsVersion: TERMS_VERSION },
      });
      finishAuth(data, 'pin');
    } catch (err) {
      setPin('');
      setPinFailed(true);
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(codeValue?: string) {
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/verify-otp', {
        body: {
          phone,
          code: codeValue ?? code,
          referralCode: referralCode.trim() || undefined,
          ...(pinReset ? { purpose: 'PIN_RESET' } : {}),
          termsVersion: TERMS_VERSION,
        },
      });
      finishAuth(data, 'otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const me = await api<AuthUser>('/api/auth/me', {
        method: 'PATCH',
        body: { name: name.trim() },
        auth: true,
      });
      setStoredUser(me);
      setUser(me);
      await api('/api/addresses', {
        body: {
          name: name.trim(),
          phone: altPhone.trim() || phone,
          line1: line1.trim(),
          city: city.trim(),
          state: stateName.trim(),
          pincode: pincode.trim(),
          isDefault: true,
        },
        auth: true,
      });
      setStep('photo');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  }

  async function savePhotoAndContinue() {
    setError('');
    setBusy(true);
    try {
      if (photoFile) {
        await consent.ensure();
        const [photo] = await uploadPrivateImages([photoFile], 'TRYON_PHOTO');
        await api('/api/tryon/photo', { body: { photoRef: photo.ref }, auth: true });
      }
      setBusy(false);
      setStep('setpin');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Photo upload failed');
      setBusy(false);
    }
  }

  async function savePinAndFinish(pinValue: string, confirmValue?: string) {
    setError('');
    if (confirmValue !== undefined && confirmValue !== pinValue) {
      setError('The two PINs don’t match — enter them again.');
      setPin('');
      setPinConfirm('');
      return;
    }
    setBusy(true);
    try {
      const me = await api<AuthUser>('/api/auth/me/set-pin', {
        body: { pin: pinValue, ...(confirmValue !== undefined ? { confirmPin: confirmValue } : {}) },
        auth: true,
      });
      setPinReset(false);
      setStoredUser(me);
      rememberMethod('pin');
      router.push(dashboardFor(me.role));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save PIN');
      setBusy(false);
    }
  }

  // ------------------- Split-screen auth experience -------------------
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* ============ LEFT: brand panel — the exact reference artwork ============ */}
      <aside className="sticky top-0 hidden h-screen shrink-0 bg-black lg:block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/login-panel.jpg"
          alt="Clowe — Your Style, Our Intelligence"
          className="h-full w-auto select-none"
          draggable={false}
        />
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
          <span className="font-display text-xl font-bold uppercase tracking-[0.25em] text-brand-400">
            Clowe
          </span>
          <p className="mt-0.5 text-[11px] text-brand-400/80">Your Style, Our Intelligence.</p>
        </div>

        {/* Top-right signup switch */}
        <div className="relative z-10 flex items-center justify-end gap-3 px-6 pt-5">
          <span className="hidden text-sm text-gray-500 sm:inline">
            {signupMode ? 'Already have an account?' : 'New to Clowe?'}
          </span>
          <button
            onClick={() => {
              setSignupMode((v) => !v);
              setPinReset(false);
              setStep('phone');
              setError('');
              setNotice('');
            }}
            className="rounded-lg border-2 border-brand-600 px-4 py-1.5 text-sm font-bold text-brand-600 hover:bg-brand-50"
          >
            {signupMode ? 'Login' : 'Create Account'}
          </button>
        </div>

        <div className="relative z-10 flex flex-1 items-start justify-center px-4 py-6 sm:items-center sm:py-10">
          <div className="relative w-full max-w-md rounded-3xl border border-gray-100 bg-white p-6 shadow-xl sm:p-9">
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
            {/* Card header */}
            <h2 className="text-center font-display text-3xl font-bold text-ink-900">
              {step === 'newpin'
                ? 'Choose a New PIN'
                : step === 'profile'
                ? 'Almost there!'
                : step === 'photo'
                  ? 'Your Try-On Photo'
                  : step === 'setpin'
                    ? 'Set a Quick PIN'
                    : signupMode
                      ? 'Create Account'
                      : 'Welcome Back'}
            </h2>
            <p className="mt-1.5 text-center text-sm text-gray-500">
              {step === 'newpin'
                ? 'Your old PIN no longer works. Set a new one to continue.'
                : step === 'profile'
                ? 'Tell us a little about yourself — you only do this once'
                : step === 'photo'
                  ? 'Upload once — every ✨ Try On Me uses it automatically'
                  : step === 'setpin'
                    ? '4-digit PIN for faster login — no OTP next time'
                    : signupMode
                      ? 'Join Clowe with just your phone number'
                      : 'Login to continue to your account'}
            </p>
            <div className="mt-4">
              <HangerDivider />
            </div>

            {notice && (
              <div className="mt-5 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                {notice}
              </div>
            )}
            {error && (
              <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
                {pinFailed && step === 'pin' && (
                  <button type="button" onClick={() => void chooseOtp()} className="ml-1 font-semibold underline">
                    Get OTP instead
                  </button>
                )}
              </div>
            )}

            {/* ---------------- Step: phone ---------------- */}
            {step === 'phone' && (
              <form
                className="mt-6 space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitPhone();
                }}
              >
                <div>
                  <label className="text-sm font-semibold text-ink-900">Phone Number</label>
                  <div className="mt-1.5 flex overflow-hidden rounded-xl border border-gray-300 bg-white focus-within:border-brand-600 focus-within:ring-2 focus-within:ring-brand-100">
                    <span className="flex items-center border-r border-gray-200 bg-cream-50 px-3.5 text-sm font-semibold text-gray-600">
                      +91
                    </span>
                    <input
                      type="tel"
                      inputMode="numeric"
                      maxLength={10}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                      placeholder="10-digit mobile number"
                      className="w-full px-3.5 py-3 text-sm outline-none"
                      autoFocus
                    />
                  </div>
                </div>
                {signupMode ? (
                  // A new account starts with an OTP: there is no PIN yet.
                  <button
                    type="submit"
                    disabled={busy || phone.length !== 10}
                    className="w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
                  >
                    {busy ? 'Please wait…' : 'Get OTP'}
                  </button>
                ) : (
                  <LoginMethodChoice
                    disabled={busy || phone.length !== 10}
                    preselected={preselected}
                    busy={choosing}
                    onPin={choosePin}
                    onOtp={() => void chooseOtp()}
                  />
                )}
                <p className="text-center text-[11px] leading-relaxed text-gray-500" data-login-consent>
                  By continuing you confirm you are 18+ and agree to the{' '}
                  <Link href="/pages/terms-conditions" className="font-semibold text-brand-600 hover:underline">
                    Terms
                  </Link>{' '}
                  and{' '}
                  <Link href="/pages/privacy-policy" className="font-semibold text-brand-600 hover:underline">
                    Privacy Policy
                  </Link>
                  .
                </p>
              </form>
            )}

            {/* ---------------- Step: PIN login ---------------- */}
            {step === 'pin' && (
              <div className="mt-6 space-y-5">
                <p className="text-center text-sm text-gray-600">
                  PIN login for <span className="font-semibold">{maskedPhone(phone)}</span>{' '}
                  <button onClick={() => { setPinReset(false); setStep('phone'); }} className="text-brand-600 hover:underline">
                    Change number
                  </button>
                </p>
                <div>
                  <p className="mb-2 text-center text-sm font-semibold text-ink-900">
                    Enter your 4-digit PIN
                  </p>
                  <DigitBoxes
                    length={4}
                    value={pin}
                    onChange={setPin}
                    masked
                    autoFocus
                    onComplete={(v) => void loginWithPin(v)}
                  />
                </div>
                <button
                  onClick={() => void loginWithPin(pin)}
                  disabled={busy || pin.length !== 4}
                  className="w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
                >
                  {busy ? 'Logging in…' : 'Login'}
                </button>
                <div className="flex items-center justify-between text-sm">
                  <button onClick={() => void chooseOtp()} className="text-brand-600 hover:underline">
                    Get OTP instead
                  </button>
                  <button
                    onClick={() => void forgotPin()}
                    className="text-gray-500 hover:text-brand-600 hover:underline"
                  >
                    Forgot PIN?
                  </button>
                </div>
              </div>
            )}

            {/* ---------------- Step: OTP ---------------- */}
            {step === 'otp' && (
              <div className="mt-6 space-y-5">
                <p className="text-center text-sm text-gray-600">
                  OTP sent to <span className="font-semibold">{maskedPhone(phone)}</span>{' '}
                  <button onClick={() => { setPinReset(false); setStep('phone'); }} className="text-brand-600 hover:underline">
                    Change
                  </button>
                  {!signupMode && (
                    <>
                      {' · '}
                      {/* Straight to the PIN for this number; nothing is sent, and a
                          pending "Forgot PIN?" is dropped (its PIN is untouched until a
                          code is verified). */}
                      <button
                        onClick={() => {
                          setPinReset(false);
                          choosePin();
                        }}
                        className="text-brand-600 hover:underline"
                      >
                        Use PIN instead
                      </button>
                    </>
                  )}
                </p>
                {devOtp && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-center text-sm text-blue-800">
                    <span className="font-semibold">Dev mode:</span> OTP is{' '}
                    <span className="font-mono text-base font-bold tracking-widest">{devOtp}</span>
                  </div>
                )}
                <DigitBoxes
                  length={6}
                  value={code}
                  onChange={setCode}
                  autoFocus
                  onComplete={(v) => void verifyOtp(v)}
                />
                <details className="text-center text-sm text-gray-500">
                  <summary className="cursor-pointer select-none">Have a referral code?</summary>
                  <input
                    type="text"
                    value={referralCode}
                    onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                    placeholder="Referral code (optional)"
                    className={`mt-3 ${field}`}
                  />
                </details>
                <button
                  onClick={() => void verifyOtp()}
                  disabled={busy || code.length !== 6}
                  className="w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
                >
                  {busy ? 'Verifying…' : 'Verify & Login'}
                </button>
                <ResendOtp
                  key={otpSent?.n ?? 0}
                  phone={phone}
                  firstSent={otpSent?.result ?? null}
                  onSent={(r) => {
                    setDevOtp(r.devOtp ?? '');
                    setCode(r.devOtp ?? '');
                  }}
                />
              </div>
            )}

            {/* ---------------- Step: profile (new users) ---------------- */}
            {step === 'profile' && (
              <form className="mt-6 space-y-3" onSubmit={(e) => void saveProfile(e)}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name *" required minLength={2} className={field} autoFocus />
                <input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Address (house no, street) *" required minLength={3} className={field} />
                <div className="grid grid-cols-2 gap-3">
                  <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City *" required minLength={2} className={field} />
                  <input value={stateName} onChange={(e) => setStateName(e.target.value)} placeholder="State *" required minLength={2} className={field} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, ''))} maxLength={6} placeholder="Pincode *" required className={field} />
                  <input value={altPhone} onChange={(e) => setAltPhone(e.target.value.replace(/\D/g, ''))} maxLength={10} placeholder="Alternate phone" className={field} />
                </div>
                <button
                  type="submit"
                  disabled={busy || !name.trim() || !line1.trim() || !city.trim() || !stateName.trim() || pincode.length !== 6}
                  className="w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Continue →'}
                </button>
              </form>
            )}

            {/* ---------------- Step: try-on photo (new users) ---------------- */}
            {step === 'photo' && (
              <div className="mt-6 space-y-4">
                {photoPreview ? (
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoPreview} alt="Your photo" className="max-h-72 w-full rounded-xl bg-cream-100 object-contain" />
                    <label className="absolute right-2 top-2 cursor-pointer rounded-full bg-white/90 px-3 py-1 text-xs font-semibold shadow">
                      Change
                      <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" className="hidden" onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)} />
                    </label>
                  </div>
                ) : (
                  <label className="flex h-48 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-cream-50 text-gray-500 hover:border-brand-600 hover:text-brand-600">
                    <span className="text-3xl">📷</span>
                    <span className="mt-2 text-sm font-medium">Upload your photo</span>
                    <span className="mt-1 text-xs text-gray-400">Full-body, front-facing works best</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" className="hidden" onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)} />
                  </label>
                )}
                {photoFile && consent.consented === false && (
                  <TryOnConsentBox ticked={consent.ticked} onChange={consent.setTicked} />
                )}
                <button
                  onClick={() => void savePhotoAndContinue()}
                  disabled={busy || (!!photoFile && !consent.ready)}
                  className="w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
                >
                  {busy ? 'Saving…' : photoFile ? 'Save & Continue →' : 'Skip for now →'}
                </button>
              </div>
            )}

            {/* ---------------- Step: set PIN (skippable) ---------------- */}
            {step === 'setpin' && user && (
              <div className="mt-6 space-y-5">
                <DigitBoxes length={4} value={pin} onChange={setPin} masked autoFocus />
                <button
                  onClick={() => void savePinAndFinish(pin)}
                  disabled={busy || pin.length !== 4}
                  className="w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save PIN & Continue'}
                </button>
                <button
                  onClick={() => router.push(dashboardFor(user.role))}
                  className="w-full text-center text-sm text-gray-500 hover:text-brand-600 hover:underline"
                >
                  Skip for now
                </button>
              </div>
            )}

            {/* ---------------- Step: new PIN after "Forgot PIN?" (required) ---------------- */}
            {step === 'newpin' && user && (
              <div className="mt-6 space-y-5" data-new-pin>
                <div>
                  <p className="mb-2 text-center text-sm font-semibold text-ink-900">New 4-digit PIN</p>
                  <DigitBoxes length={4} value={pin} onChange={setPin} masked autoFocus />
                </div>
                <div>
                  <p className="mb-2 text-center text-sm font-semibold text-ink-900">Enter it again</p>
                  <DigitBoxes
                    length={4}
                    value={pinConfirm}
                    onChange={setPinConfirm}
                    masked
                    onComplete={(v) => {
                      if (pin.length === 4) void savePinAndFinish(pin, v);
                    }}
                  />
                </div>
                <button
                  onClick={() => void savePinAndFinish(pin, pinConfirm)}
                  disabled={busy || pin.length !== 4 || pinConfirm.length !== 4}
                  className="w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save new PIN & Continue'}
                </button>
                <p className="text-center text-xs text-gray-500">
                  You&apos;ve been signed out on your other devices. If you leave now, sign in with an OTP next
                  time.
                </p>
              </div>
            )}

            {/* Card footer */}
            {(step === 'phone' || step === 'pin' || step === 'otp') && (
              <p className="mt-7 text-center text-xs text-gray-400">
                By continuing, you agree to our{' '}
                <Link href="/" className="text-brand-600 hover:underline">
                  Terms of Use
                </Link>{' '}
                and{' '}
                <Link href="/" className="text-brand-600 hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            )}
          </div>
        </div>

        <LegalCopyright className="pb-5 text-center text-xs text-gray-400" />
      </main>
    </div>
  );
}
