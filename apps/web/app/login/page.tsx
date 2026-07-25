'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthTokensResponse, AuthUser, UserRole } from '@clowe/shared';
import {
  api,
  ApiRequestError,
  clearSession,
  getRefreshToken,
  getStoredUser,
  saveSession,
  setStoredUser,
  uploadImages,
} from '@/lib/api';
import TryOnPhotoCard from '@/components/TryOnPhotoCard';
import AccountStats from '@/components/AccountStats';

type Step = 'phone' | 'otp' | 'profile' | 'photo' | 'done';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600';

/** Every role lands on its own dashboard after login. */
function dashboardFor(role: UserRole): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'SELLER') return '/seller';
  return '/products';
}

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [devOtp, setDevOtp] = useState('');

  // Onboarding (new users only)
  const [name, setName] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [pincode, setPincode] = useState('');
  const [altPhone, setAltPhone] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');

  // Already logged in? Show the account view straight away.
  useEffect(() => {
    const stored = getStoredUser();
    if (stored) {
      setUser(stored);
      setStep('done');
    }
  }, []);

  useEffect(() => {
    if (!photoFile) return;
    const url = URL.createObjectURL(photoFile);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  async function requestOtp() {
    setError('');
    setBusy(true);
    try {
      const data = await api<{ resendAfterSec: number; devOtp?: string }>('/api/auth/request-otp', {
        body: { phone },
      });
      // Dev convenience: the API returns the OTP outside production.
      if (data.devOtp) {
        setDevOtp(data.devOtp);
        setCode(data.devOtp);
      }
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/verify-otp', {
        body: { phone, code, referralCode: referralCode.trim() || undefined },
      });
      saveSession(data);
      setUser(data.user);
      if (data.isNewUser) {
        // First-time signup → collect profile, then the try-on photo.
        setStep('profile');
      } else {
        // Returning user → straight to their dashboard, nothing to fill.
        router.push(dashboardFor(data.user.role));
      }
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

  async function savePhotoAndFinish() {
    setError('');
    setBusy(true);
    try {
      if (photoFile) {
        const [url] = await uploadImages([photoFile]);
        await api('/api/tryon/photo', { body: { photoUrl: url }, auth: true });
      }
      router.push(dashboardFor(user?.role ?? 'CUSTOMER'));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Photo upload failed');
      setBusy(false);
    }
  }

  async function logout() {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        await api('/api/auth/logout', { body: { refreshToken } });
      } catch {
        // Local logout still proceeds if the API call fails.
      }
    }
    clearSession();
    setUser(null);
    setPhone('');
    setCode('');
    setStep('phone');
  }

  const titles: Record<Step, string> = {
    phone: 'Login to Clowe',
    otp: 'Verify OTP',
    profile: 'Complete your profile',
    photo: 'Add your try-on photo',
    done: 'My account',
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-md">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">
          ← Back
        </Link>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-brand-900">{titles[step]}</h1>

        {step === 'phone' && (
          <p className="mt-2 text-sm text-gray-500">
            Enter your mobile number and we&apos;ll send you a one-time password.
          </p>
        )}
        {step === 'profile' && (
          <p className="mt-2 text-sm text-gray-500">
            Welcome to Clowe! 🎉 Tell us a little about yourself — you only do this once.
          </p>
        )}
        {step === 'photo' && (
          <p className="mt-2 text-sm text-gray-500">
            Upload a full-body photo once — every ✨ Try On Me will use it automatically. You can
            change it anytime from your account.
          </p>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* ---------------- Step 1: phone ---------------- */}
        {step === 'phone' && (
          <form
            className="mt-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void requestOtp();
            }}
          >
            <div className="flex overflow-hidden rounded-lg border border-gray-300 bg-white focus-within:border-brand-600">
              <span className="flex items-center border-r border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">
                +91
              </span>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                placeholder="10-digit mobile number"
                className="w-full px-3 py-2.5 text-sm outline-none"
                autoFocus
              />
            </div>
            <button
              type="submit"
              disabled={busy || phone.length !== 10}
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send OTP'}
            </button>
          </form>
        )}

        {/* ---------------- Step 2: OTP ---------------- */}
        {step === 'otp' && (
          <form
            className="mt-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyOtp();
            }}
          >
            <p className="text-sm text-gray-600">
              OTP sent to <span className="font-semibold">+91 {phone}</span>{' '}
              <button
                type="button"
                onClick={() => setStep('phone')}
                className="text-brand-600 hover:underline"
              >
                change
              </button>
            </p>
            {devOtp && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                <span className="font-semibold">Dev mode:</span> your OTP is{' '}
                <span className="font-mono text-base font-bold tracking-widest">{devOtp}</span>{' '}
                (pre-filled below)
              </div>
            )}
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="6-digit OTP"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-brand-600"
              autoFocus
            />
            <details className="text-sm text-gray-500">
              <summary className="cursor-pointer select-none">Have a referral code?</summary>
              <input
                type="text"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                placeholder="Referral code (optional)"
                className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
            </details>
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Verify & Login'}
            </button>
          </form>
        )}

        {/* ---------------- Step 3 (new users): profile ---------------- */}
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
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Continue →'}
            </button>
          </form>
        )}

        {/* ---------------- Step 4 (new users): try-on photo ---------------- */}
        {step === 'photo' && (
          <div className="mt-6 space-y-4">
            {photoPreview ? (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoPreview} alt="Your photo" className="max-h-80 w-full rounded-xl bg-gray-50 object-contain" />
                <label className="absolute right-2 top-2 cursor-pointer rounded-full bg-white/90 px-3 py-1 text-xs font-semibold shadow">
                  Change
                  <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" className="hidden" onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)} />
                </label>
              </div>
            ) : (
              <label className="flex h-56 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 text-gray-500 hover:border-brand-600 hover:text-brand-600">
                <span className="text-3xl">📷</span>
                <span className="mt-2 text-sm font-medium">Upload your photo</span>
                <span className="mt-1 text-xs text-gray-400">Full-body, front-facing works best</span>
                <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" className="hidden" onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)} />
              </label>
            )}
            <button
              onClick={() => void savePhotoAndFinish()}
              disabled={busy}
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : photoFile ? 'Save & start shopping →' : 'Skip for now →'}
            </button>
          </div>
        )}

        {/* ---------------- Account view (already logged in) ---------------- */}
        {step === 'done' && user && (
          <div className="mt-6 space-y-4">
            <p className="text-sm text-gray-500">
              Hello, <span className="font-semibold text-ink-900">{user.name ?? 'there'}</span> 👋
              Welcome back!
            </p>
            <AccountStats />
            <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
              <dl className="space-y-2">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Name</dt>
                  <dd className="font-medium">{user.name ?? '—'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Phone</dt>
                  <dd className="font-medium">+91 {user.phone}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Role</dt>
                  <dd>
                    <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-600">
                      {user.role}
                    </span>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Referral code</dt>
                  <dd className="font-mono font-medium">{user.referralCode}</dd>
                </div>
              </dl>
            </div>
            <Link
              href={dashboardFor(user.role)}
              className="block w-full rounded-lg bg-brand-600 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-700"
            >
              {user.role === 'ADMIN'
                ? 'Open Admin Dashboard →'
                : user.role === 'SELLER'
                  ? 'Open Seller Dashboard →'
                  : 'Continue Shopping →'}
            </Link>
            <TryOnPhotoCard />
            <div className="grid grid-cols-2 gap-2 text-sm">
              <Link href="/orders" className="rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
                📦 My Orders
              </Link>
              <Link href="/referrals" className="rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
                🎁 Refer & Earn
              </Link>
              <Link href="/tryon" className="rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
                ✨ My Try-Ons
              </Link>
              <Link href="/track" className="rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
                🚚 Track Order
              </Link>
            </div>
            <button
              onClick={() => void logout()}
              className="w-full rounded-lg border border-gray-300 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-100"
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
