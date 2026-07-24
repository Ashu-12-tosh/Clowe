'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthTokensResponse } from '@clowe/shared';
import { api, ApiRequestError, saveSession } from '@/lib/api';
import { useSeller } from '@/components/seller/SellerContext';

export default function SellerLoginPage() {
  const router = useRouter();
  const { reload } = useSeller();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendOtp() {
    setError('');
    setBusy(true);
    try {
      // Seller-only gate: OTP goes out only for registered seller numbers.
      const check = await api<{ isSeller: boolean }>('/api/seller/check-phone', {
        body: { phone },
      });
      if (!check.isSeller) {
        setError('This number is not registered as a seller. Register your shop first.');
        return;
      }
      const otp = await api<{ devOtp?: string }>('/api/auth/request-otp', { body: { phone } });
      if (otp.devOtp) {
        setDevOtp(otp.devOtp);
        setCode(otp.devOtp);
      }
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/verify-otp', {
        body: { phone, code },
      });
      saveSession(data);
      reload();
      router.push('/seller'); // straight to the seller dashboard
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-10">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand-600">Seller Panel</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight text-brand-900">Seller Login</h1>
      <p className="mt-2 text-sm text-gray-500">
        Only registered seller numbers can login here — you&apos;ll land straight on your dashboard.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}{' '}
          {error.includes('not registered') && (
            <Link href="/sell" className="font-semibold underline">
              Sell on Clowe →
            </Link>
          )}
        </div>
      )}

      {step === 'phone' && (
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void sendOtp();
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
              placeholder="Registered seller mobile number"
              className="w-full px-3 py-2.5 text-sm outline-none"
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={busy || phone.length !== 10}
            className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Send OTP'}
          </button>
          <p className="text-center text-xs text-gray-500">
            New to selling?{' '}
            <Link href="/sell" className="font-semibold text-brand-600 hover:underline">
              See why sellers choose Clowe →
            </Link>
          </p>
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
            <button type="button" onClick={() => setStep('phone')} className="text-brand-600 hover:underline">
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
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-brand-600"
            autoFocus
          />
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Logging in…' : 'Login to Dashboard →'}
          </button>
        </form>
      )}
    </main>
  );
}
