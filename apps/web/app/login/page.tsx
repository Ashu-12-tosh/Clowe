'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthTokensResponse, AuthUser, UserRole } from '@clowe/shared';
import {
  api,
  ApiRequestError,
  getStoredUser,
  saveSession,
  setStoredUser,
  uploadImages,
} from '@/lib/api';

type Step = 'phone' | 'pin' | 'otp' | 'profile' | 'photo' | 'setpin';

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
  const [code, setCode] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [devOtp, setDevOtp] = useState('');
  const [signupMode, setSignupMode] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // Onboarding (new users only)
  const [name, setName] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [pincode, setPincode] = useState('');
  const [altPhone, setAltPhone] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');

  // Already logged in? This page is auth-only — send them to their account.
  useEffect(() => {
    if (getStoredUser()) router.replace('/account');
  }, [router]);

  // OTP resend countdown.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  useEffect(() => {
    if (!photoFile) return;
    const url = URL.createObjectURL(photoFile);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  /** After any successful auth: new user → onboarding; no PIN → offer one; else dashboard. */
  function finishAuth(data: AuthTokensResponse) {
    saveSession(data);
    setUser(data.user);
    setError('');
    setNotice('');
    if (data.isNewUser) setStep('profile');
    else if (!data.user.hasPin) setStep('setpin');
    else router.push(dashboardFor(data.user.role));
  }

  async function sendOtp(message?: string) {
    setError('');
    setBusy(true);
    try {
      const data = await api<{ resendAfterSec: number; devOtp?: string }>('/api/auth/request-otp', {
        body: { phone },
      });
      if (data.devOtp) {
        setDevOtp(data.devOtp);
        setCode(data.devOtp);
      } else {
        setCode('');
      }
      if (message) setNotice(message);
      setResendIn(60);
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  /** Step 1 → does this account have a PIN? */
  async function continueFromPhone() {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const info = await api<{ exists: boolean; hasPin: boolean }>('/api/auth/check-phone', {
        body: { phone },
      });
      if (info.exists && info.hasPin) {
        setPin('');
        setBusy(false);
        setStep('pin');
      } else {
        await sendOtp();
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setBusy(false);
    }
  }

  async function loginWithPin(pinValue: string) {
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/pin-login', {
        body: { phone, pin: pinValue },
      });
      finishAuth(data);
    } catch (err) {
      setPin('');
      if (err instanceof ApiRequestError && err.code === 'PIN_LOCKED') {
        await sendOtp("Too many attempts — we've sent an OTP instead.");
      } else {
        setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      }
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(codeValue?: string) {
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/verify-otp', {
        body: { phone, code: codeValue ?? code, referralCode: referralCode.trim() || undefined },
      });
      finishAuth(data);
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
        const [url] = await uploadImages([photoFile]);
        await api('/api/tryon/photo', { body: { photoUrl: url }, auth: true });
      }
      setBusy(false);
      setStep('setpin');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Photo upload failed');
      setBusy(false);
    }
  }

  async function savePinAndFinish(pinValue: string) {
    setError('');
    setBusy(true);
    try {
      const me = await api<AuthUser>('/api/auth/me/set-pin', {
        body: { pin: pinValue },
        auth: true,
      });
      setStoredUser(me);
      router.push(dashboardFor(me.role));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save PIN');
      setBusy(false);
    }
  }

  // ------------------- Split-screen auth experience -------------------
  return (
    <main className="flex min-h-screen flex-col lg:flex-row">
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

      {/* ============ RIGHT: auth card ============ */}
      <section className="flex flex-1 flex-col bg-cream-50">
        {/* Mobile compact brand header */}
        <div className="bg-ink-950 px-5 py-4 text-center lg:hidden">
          <span className="font-display text-xl font-bold uppercase tracking-[0.25em] text-brand-400">
            Clowe
          </span>
          <p className="mt-0.5 text-[11px] text-brand-400/80">Your Style, Our Intelligence.</p>
        </div>

        {/* Top-right signup switch */}
        <div className="flex items-center justify-end gap-3 px-6 pt-5">
          <span className="hidden text-sm text-gray-500 sm:inline">
            {signupMode ? 'Already have an account?' : 'New to Clowe?'}
          </span>
          <button
            onClick={() => {
              setSignupMode((v) => !v);
              setStep('phone');
              setError('');
              setNotice('');
            }}
            className="rounded-lg border-2 border-brand-600 px-4 py-1.5 text-sm font-bold text-brand-600 hover:bg-brand-50"
          >
            {signupMode ? 'Login' : 'Create Account'}
          </button>
        </div>

        <div className="flex flex-1 items-start justify-center px-4 py-6 sm:items-center sm:py-10">
          <div className="w-full max-w-md rounded-3xl border border-gray-100 bg-white p-6 shadow-sm sm:p-9">
            {/* Card header */}
            <h2 className="text-center font-display text-3xl font-bold text-ink-900">
              {step === 'profile'
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
              {step === 'profile'
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
              </div>
            )}

            {/* ---------------- Step: phone ---------------- */}
            {step === 'phone' && (
              <form
                className="mt-6 space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void continueFromPhone();
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
                <button
                  type="submit"
                  disabled={busy || phone.length !== 10}
                  className="w-full rounded-xl bg-brand-600 py-3 text-sm font-bold uppercase tracking-wide text-white shadow hover:bg-brand-700 disabled:opacity-50"
                >
                  {busy ? 'Please wait…' : 'Continue'}
                </button>
              </form>
            )}

            {/* ---------------- Step: PIN login ---------------- */}
            {step === 'pin' && (
              <div className="mt-6 space-y-5">
                <p className="text-center text-sm text-gray-600">
                  Welcome back, <span className="font-semibold">{maskedPhone(phone)}</span>{' '}
                  <button onClick={() => setStep('phone')} className="text-brand-600 hover:underline">
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
                  <button onClick={() => void sendOtp()} className="text-brand-600 hover:underline">
                    Use OTP instead
                  </button>
                  <button
                    onClick={() => void sendOtp("No problem — login with OTP, then set a new PIN from this screen.")}
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
                  <button onClick={() => setStep('phone')} className="text-brand-600 hover:underline">
                    Change
                  </button>
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
                <p className="text-center text-sm text-gray-500">
                  {resendIn > 0 ? (
                    <>Resend OTP in {resendIn}s</>
                  ) : (
                    <button onClick={() => void sendOtp()} className="font-semibold text-brand-600 hover:underline">
                      Resend OTP
                    </button>
                  )}
                </p>
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
                <button
                  onClick={() => void savePhotoAndContinue()}
                  disabled={busy}
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

        <p className="pb-5 text-center text-xs text-gray-400">
          © {new Date().getFullYear()} Clowe. All rights reserved.
        </p>
      </section>
    </main>
  );
}
