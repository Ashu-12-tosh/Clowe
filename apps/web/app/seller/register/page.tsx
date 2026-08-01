'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  sellerRegisterSchema,
  type AuthTokensResponse,
  type SellerRegisterInput,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser, refreshSession, saveSession } from '@/lib/api';
import { useSeller } from '@/components/seller/SellerContext';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

export default function SellerRegisterPage() {
  const router = useRouter();
  const { state, reload } = useSeller();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Guest flow: application details are held while the phone is verified.
  const [step, setStep] = useState<'form' | 'otp'>('form');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [pendingApplication, setPendingApplication] = useState<SellerRegisterInput | null>(null);

  const loggedIn = typeof window !== 'undefined' && !!getStoredUser();

  // Already a seller → straight to the dashboard.
  if (state.kind === 'ready') {
    router.replace('/seller');
    return null;
  }

  /** Create the seller profile for the logged-in session, then open the dashboard. */
  async function submitProfile(input: SellerRegisterInput) {
    try {
      await api('/api/seller/register', { body: input, auth: true });
    } catch (err) {
      // Phone already has a seller account → just take them to their dashboard.
      if (!(err instanceof ApiRequestError && err.code === 'ALREADY_REGISTERED')) throw err;
    }
    await refreshSession(); // role changed to SELLER → fresh token
    reload();
    router.replace('/seller');
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');

    const form = new FormData(e.currentTarget);
    const enteredPhone = String(form.get('phone') ?? '').trim();
    form.delete('phone');
    const raw = Object.fromEntries(
      [...form.entries()].filter(([, v]) => String(v).trim() !== ''),
    ) as Record<string, string>;

    const parsed = sellerRegisterSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join('.')}: ${issue.message}`);
      return;
    }

    setBusy(true);
    try {
      if (loggedIn) {
        // Already logged in — no OTP needed, the session proves the phone.
        await submitProfile(parsed.data);
        return;
      }
      // Guest — verify the phone via OTP before creating anything.
      if (!/^[6-9]\d{9}$/.test(enteredPhone)) {
        setError('Enter a valid 10-digit mobile number');
        return;
      }
      const otp = await api<{ devOtp?: string }>('/api/auth/request-otp', {
        body: { phone: enteredPhone },
      });
      if (otp.devOtp) {
        setDevOtp(otp.devOtp);
        setCode(otp.devOtp);
      }
      setPhone(enteredPhone);
      setPendingApplication(parsed.data);
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  /** OTP verified → login/create the account, then attach the seller profile. */
  async function verifyAndRegister() {
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/verify-otp', {
        body: { phone, code, name: pendingApplication?.shopName },
      });
      saveSession(data);
      await submitProfile(pendingApplication!);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setBusy(false);
    }
  }

  // ---------------- OTP step (guest flow) ----------------
  if (step === 'otp') {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-2xl font-bold">Verify your phone</h1>
        <p className="mt-2 text-sm text-gray-500">
          Your seller account will be linked to <span className="font-semibold">+91 {phone}</span>{' '}
          <button onClick={() => setStep('form')} className="text-brand-600 hover:underline">
            change
          </button>
        </p>
        {devOtp && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            <span className="font-semibold">Dev mode:</span> your OTP is{' '}
            <span className="font-mono text-base font-bold tracking-widest">{devOtp}</span>
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void verifyAndRegister();
          }}
        >
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
            {busy ? 'Verifying…' : 'Verify & Submit application'}
          </button>
        </form>
      </main>
    );
  }

  // ---------------- Application form ----------------
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="text-2xl font-bold">Become a Clowe seller</h1>
      <p className="mt-1 text-sm text-gray-600">
        Register your shop. Our team (admin) reviews every application before you can list products.
      </p>
      <p className="mt-1 text-xs text-gray-500">
        Already a seller?{' '}
        <Link href="/seller/login" className="font-semibold text-brand-600 hover:underline">
          Seller login →
        </Link>
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form className="mt-6 space-y-4" onSubmit={(e) => void onSubmit(e)}>
        {!loggedIn && (
          <div>
            <label className="text-sm font-medium">Mobile number * (OTP will be sent here)</label>
            <div className="mt-1 flex overflow-hidden rounded-lg border border-gray-300 bg-white focus-within:border-brand-600">
              <span className="flex items-center border-r border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">
                +91
              </span>
              <input
                name="phone"
                type="tel"
                inputMode="numeric"
                maxLength={10}
                required
                placeholder="10-digit mobile number"
                className="w-full px-3 py-2 text-sm outline-none"
              />
            </div>
          </div>
        )}
        <div>
          <label className="text-sm font-medium">Shop name *</label>
          <input name="shopName" required minLength={3} className={`mt-1 ${field}`} placeholder="e.g. Ashu Fashion House" />
        </div>
        <div>
          <label className="text-sm font-medium">About your shop</label>
          <textarea name="description" rows={2} className={`mt-1 ${field}`} placeholder="What do you sell?" />
        </div>
        <div>
          <label className="text-sm font-medium">Seller referral code (optional)</label>
          <input
            name="referralCode"
            maxLength={10}
            className={`mt-1 ${field} uppercase`}
            placeholder="SLR-XXXXXX"
          />
          <p className="mt-1 text-xs text-gray-400">
            Got a code from another Clowe seller? They earn a bonus when your shop takes off.
          </p>
        </div>

        <fieldset className="rounded-lg border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-700">KYC (optional in dev)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="gstNumber" className={field} placeholder="GST number" />
            <input name="panNumber" className={field} placeholder="PAN number" />
            <input name="bankAccountName" className={field} placeholder="Bank account name" />
            <input name="bankAccountNo" className={field} placeholder="Bank account number" />
            <input name="bankIfsc" className={field} placeholder="IFSC code" />
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-700">Pickup address</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="addressLine1" className={`sm:col-span-2 ${field}`} placeholder="Address line" />
            <input name="city" className={field} placeholder="City" />
            <input name="state" className={field} placeholder="State" />
            <input name="pincode" className={field} placeholder="Pincode (6 digits)" />
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Submitting…' : loggedIn ? 'Submit application' : 'Send OTP & Submit'}
        </button>
      </form>
    </main>
  );
}
