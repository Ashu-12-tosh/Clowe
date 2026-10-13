'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  phoneSubmitAction,
  preselectedLoginMethod,
  type AuthTokensResponse,
  type AuthUser,
  type OtpRequestResult,
  type SellerProfileInfo,
} from '@clowe/shared';
import ResendOtp from '@/components/auth/ResendOtp';
import LoginMethodChoice from '@/components/auth/LoginMethodChoice';
import { api, ApiRequestError, saveSession, setStoredUser } from '@/lib/api';
import { lastLoginMethod, rememberLoginMethod, type LoginMethod } from '@/lib/loginMethod';
import { useSeller } from '@/components/seller/SellerContext';

type Step = 'phone' | 'pin' | 'otp' | 'newpin' | 'no-seller';

const input =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-brand-600';

export default function SellerLoginPage() {
  const router = useRouter();
  const { reload } = useSeller();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [otpSent, setOtpSent] = useState<{ result: OtpRequestResult; n: number } | null>(null);
  /** "Forgot PIN?": the OTP about to be checked resets the PIN. */
  const [pinReset, setPinReset] = useState(false);
  /** "Login with PIN" is preselected on a device last signed in with a PIN; nothing else is. */
  const [preselected, setPreselected] = useState<LoginMethod | null>(null);
  useEffect(() => setPreselected(preselectedLoginMethod(lastLoginMethod())), []);
  const [error, setError] = useState('');
  /** A PIN login failed: offer OTP right there. */
  const [pinFailed, setPinFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<LoginMethod | 'verify' | null>(null);

  function backToPhone() {
    setPinReset(false);
    setError('');
    setNotice('');
    setPinFailed(false);
    setStep('phone');
  }

  function choosePin() {
    setError('');
    setNotice('');
    setPinFailed(false);
    setPin('');
    setStep('pin');
  }

  async function sendOtp(reset: boolean, message?: string) {
    setError('');
    setPinFailed(false);
    setBusy('otp');
    try {
      // Any number gets an OTP; whether it has a seller account is told only
      // after it is verified.
      const otp = await api<OtpRequestResult>('/api/auth/request-otp', { body: { phone } });
      setDevOtp(otp.devOtp ?? '');
      setCode(otp.devOtp ?? '');
      setOtpSent((prev) => ({ result: otp, n: (prev?.n ?? 0) + 1 }));
      setPinReset(reset);
      setNotice(message ?? '');
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(null);
    }
  }

  /** Signed in: a reset PIN is replaced first; then only a seller goes on to the dashboard. */
  async function afterSignIn(data: AuthTokensResponse, method: LoginMethod) {
    saveSession(data);
    if (data.pinResetRequired) {
      setPin('');
      setPinConfirm('');
      setNotice('');
      setStep('newpin');
      setBusy(null);
      return;
    }
    await enterDashboard(method);
  }

  /** Only a seller goes on to the dashboard; anyone else is offered registration. */
  async function enterDashboard(method: LoginMethod) {
    rememberLoginMethod(method);
    try {
      await api<SellerProfileInfo>('/api/seller/profile', { auth: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'SELLER_PROFILE_REQUIRED') {
        setStep('no-seller');
        setBusy(null);
        return;
      }
      throw err;
    }
    reload();
    // Deep links (e.g. a scanned label QR) send the seller back where they started.
    const next = new URLSearchParams(window.location.search).get('next');
    router.push(next && next.startsWith('/seller/') ? next : '/seller');
  }

  async function loginWithPin() {
    setError('');
    setPinFailed(false);
    setBusy('pin');
    try {
      const data = await api<AuthTokensResponse>('/api/auth/pin-login', { body: { phone, pin } });
      await afterSignIn(data, 'pin');
    } catch (err) {
      setPin('');
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setPinFailed(true);
      setBusy(null);
    }
  }

  async function verify() {
    setError('');
    setBusy('verify');
    try {
      const data = await api<AuthTokensResponse>('/api/auth/verify-otp', {
        body: { phone, code, ...(pinReset ? { purpose: 'PIN_RESET' } : {}) },
      });
      await afterSignIn(data, 'otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setBusy(null);
    }
  }

  async function saveNewPin() {
    setError('');
    if (pin !== pinConfirm) {
      setError('The two PINs don’t match — enter them again.');
      setPin('');
      setPinConfirm('');
      return;
    }
    setBusy('verify');
    try {
      const me = await api<AuthUser>('/api/auth/me/set-pin', { body: { pin, confirmPin: pinConfirm }, auth: true });
      setStoredUser(me);
      setPinReset(false);
      // The session from the OTP stays; with the new PIN set, on to the dashboard.
      await enterDashboard('pin');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the PIN');
      setBusy(null);
    }
  }

  const primary =
    'w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50';
  const link = 'text-brand-600 hover:underline';

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-10">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand-600">Seller Panel</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight text-brand-900">
        {step === 'newpin' ? 'Choose a New PIN' : 'Seller Login'}
      </h1>
      <p className="mt-2 text-sm text-gray-500">
        {step === 'newpin'
          ? 'Your old PIN no longer works. Set a new one to continue.'
          : 'Login with your seller mobile number — you’ll land straight on your dashboard.'}
      </p>

      {notice && (
        <div className="mt-4 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-700">{notice}</div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          {pinFailed && step === 'pin' && (
            <button type="button" onClick={() => void sendOtp(false)} className="ml-1 font-semibold underline">
              Get OTP instead
            </button>
          )}
        </div>
      )}

      {step === 'phone' && (
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            // Enter is the PIN on a device last signed in with one; otherwise the
            // person picks — no OTP goes out until it is chosen.
            if (phoneSubmitAction({ signup: false, phoneComplete: phone.length === 10, preselected }) === 'pin') choosePin();
          }}
        >
          <div className="flex overflow-hidden rounded-lg border border-gray-300 bg-white focus-within:border-brand-600">
            <span className="flex items-center border-r border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">+91</span>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
              placeholder="Seller mobile number"
              className="w-full px-3 py-2.5 text-sm outline-none"
              autoFocus
            />
          </div>
          <LoginMethodChoice
            disabled={phone.length !== 10}
            preselected={preselected}
            busy={busy === 'pin' || busy === 'otp' ? busy : null}
            onPin={choosePin}
            onOtp={() => void sendOtp(false)}
          />
          <p className="text-center text-xs text-gray-500">
            New to selling?{' '}
            <Link href="/sell" className="font-semibold text-brand-600 hover:underline">
              See why sellers choose Clowe →
            </Link>
          </p>
        </form>
      )}

      {step === 'pin' && (
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void loginWithPin();
          }}
        >
          <p className="text-sm text-gray-600">
            PIN login for <span className="font-semibold">+91 {phone}</span>{' '}
            <button type="button" onClick={backToPhone} className={link}>
              change
            </button>
          </p>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="4-digit PIN"
            aria-label="4-digit PIN"
            className={input}
            autoFocus
          />
          <button type="submit" disabled={busy !== null || pin.length !== 4} className={primary}>
            {busy === 'pin' ? 'Logging in…' : 'Login to Dashboard →'}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" onClick={() => void sendOtp(false)} className={link}>
              Get OTP instead
            </button>
            <button
              type="button"
              onClick={() =>
                void sendOtp(true, 'Enter the code we sent. Then you’ll choose a new PIN — your old PIN stops working.')
              }
              className="text-gray-500 hover:text-brand-600 hover:underline"
            >
              Forgot PIN?
            </button>
          </div>
        </form>
      )}

      {step === 'otp' && (
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <p className="text-sm text-gray-600">
            OTP sent to <span className="font-semibold">+91 {phone}</span>{' '}
            <button type="button" onClick={backToPhone} className={link}>
              change
            </button>
          </p>
          {devOtp && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <span className="font-semibold">Dev mode:</span> your OTP is{' '}
              <span className="font-mono text-base font-bold tracking-widest">{devOtp}</span>
            </div>
          )}
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="6-digit OTP"
            className={input}
            autoFocus
          />
          <button type="submit" disabled={busy !== null || code.length !== 6} className={primary}>
            {busy === 'verify' ? 'Logging in…' : pinReset ? 'Verify & choose a new PIN →' : 'Login to Dashboard →'}
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
        </form>
      )}

      {step === 'newpin' && (
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void saveNewPin();
          }}
          data-new-pin
        >
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="New 4-digit PIN"
            aria-label="New 4-digit PIN"
            className={input}
            autoFocus
          />
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={pinConfirm}
            onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ''))}
            placeholder="Enter it again"
            aria-label="Enter the new PIN again"
            className={input}
          />
          <button type="submit" disabled={busy !== null || pin.length !== 4 || pinConfirm.length !== 4} className={primary}>
            {busy ? 'Saving…' : 'Save new PIN & continue →'}
          </button>
          <p className="text-center text-xs text-gray-500">
            You&apos;ve been signed out on your other devices. If you leave now, sign in with an OTP next time.
          </p>
        </form>
      )}

      {step === 'no-seller' && (
        <div className="mt-6 space-y-4 rounded-lg border border-gray-200 bg-white p-5">
          <p className="text-sm text-gray-700">
            <span className="font-semibold">+91 {phone}</span> has no seller account yet.
          </p>
          <Link
            href="/seller/register"
            className="block w-full rounded-lg bg-brand-600 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-700"
          >
            Register your shop →
          </Link>
          <p className="text-center text-xs text-gray-500">
            Here to shop?{' '}
            <Link href="/" className="font-semibold text-brand-600 hover:underline">
              Continue to Clowe
            </Link>
          </p>
        </div>
      )}
    </main>
  );
}
