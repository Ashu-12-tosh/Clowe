'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  sellerRegisterSchema,
  type AuthTokensResponse,
  type OtpRequestResult,
  type SellerRegisterInput,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser, refreshSession, saveSession } from '@/lib/api';
import { issuesToFieldErrors, useFieldErrors } from '@/lib/fieldErrors';
import { toast } from '@/lib/toast';
import FieldError from '@/components/FieldError';
import Spinner from '@/components/Spinner';
import { bankNameFromIfsc } from '@clowe/shared';
import { useSeller } from '@/components/seller/SellerContext';
import ResendOtp from '@/components/auth/ResendOtp';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

export default function SellerRegisterPage() {
  const router = useRouter();
  const { state, reload } = useSeller();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { errors: fieldErrors, show: showFieldErrors, fromError } = useFieldErrors();

  // Guest flow: application details are held while the phone is verified.
  const [step, setStep] = useState<'form' | 'otp'>('form');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [otpSent, setOtpSent] = useState<{ result: OtpRequestResult; n: number } | null>(null);
  const [pendingApplication, setPendingApplication] = useState<SellerRegisterInput | null>(null);
  // Prefilled from the IFSC until the seller types a bank name themselves.
  const [bankName, setBankName] = useState('');
  const [bankNameTouched, setBankNameTouched] = useState(false);

  const loggedIn = typeof window !== 'undefined' && !!getStoredUser();

  // Already a seller → straight to the dashboard.
  if (state.kind === 'ready') {
    router.replace('/seller');
    return null;
  }

  /** Create the seller profile for the logged-in session, then open the dashboard. */
  async function submitProfile(input: SellerRegisterInput) {
    try {
      // Quiet: "already registered" just opens the dashboard; anything else is reported by the caller.
      await api('/api/seller/register', { body: input, auth: true, quiet: true, success: 'Application submitted — we’ll review it shortly' });
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
    const problems = parsed.success ? {} : issuesToFieldErrors(parsed.error.issues);
    if (!loggedIn && !/^[6-9]\d{9}$/.test(enteredPhone)) problems.phone = 'Enter a valid 10-digit mobile number';
    if (showFieldErrors(problems)) {
      toast.error('Not submitted: fix the fields marked in red');
      return;
    }
    if (!parsed.success || busy) return;

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
      const otp = await api<OtpRequestResult>('/api/auth/request-otp', {
        body: { phone: enteredPhone },
      });
      setDevOtp(otp.devOtp ?? '');
      setCode(otp.devOtp ?? '');
      setOtpSent((prev) => ({ result: otp, n: (prev?.n ?? 0) + 1 }));
      setPhone(enteredPhone);
      setPendingApplication(parsed.data);
      setStep('otp');
    } catch (err) {
      fromError(err);
      const message = err instanceof ApiRequestError ? err.message : 'Could not reach the API';
      setError(message);
      toast.error(`Not submitted: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  /** OTP verified → login/create the account, then attach the seller profile. */
  async function verifyAndRegister() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const data = await api<AuthTokensResponse>('/api/auth/verify-otp', {
        body: { phone, code, name: pendingApplication?.shopName },
      });
      saveSession(data);
      await submitProfile(pendingApplication!);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : 'Could not reach the API';
      setError(message);
      toast.error(message);
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
            {busy ? <><Spinner className="mr-1" />Verifying…</> : 'Verify & Submit application'}
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
            <FieldError message={fieldErrors.phone} />
          </div>
        )}
        <div>
          <label className="text-sm font-medium">Shop name *</label>
          <input name="shopName" required minLength={3} className={`mt-1 ${field}`} placeholder="e.g. Ashu Electronics" />
          <FieldError message={fieldErrors.shopName} />
        </div>
        <div>
          <label className="text-sm font-medium">About your shop</label>
          <textarea name="description" rows={2} className={`mt-1 ${field}`} placeholder="What do you sell?" />
          <FieldError message={fieldErrors.description} />
        </div>
        <div>
          <label className="text-sm font-medium">Seller referral code (optional)</label>
          <input
            name="referralCode"
            maxLength={10}
            className={`mt-1 ${field} uppercase`}
            placeholder="SLR-XXXXXX"
          />
          <FieldError message={fieldErrors.referralCode} />
          <p className="mt-1 text-xs text-gray-400">
            Got a code from another Clowe seller? They earn a bonus when your shop takes off.
          </p>
        </div>

        <fieldset className="rounded-lg border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-700">KYC (optional in dev)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <input name="gstNumber" className={`w-full ${field}`} placeholder="GST number" />
              <FieldError message={fieldErrors.gstNumber} />
            </div>
            <div>
              <input name="panNumber" className={`w-full ${field}`} placeholder="PAN number" />
              <FieldError message={fieldErrors.panNumber} />
            </div>
            <div>
              <input name="bankAccountName" className={`w-full ${field}`} placeholder="Bank account name" />
              <FieldError message={fieldErrors.bankAccountName} />
            </div>
            <div>
              <input name="bankAccountNo" className={`w-full ${field}`} placeholder="Bank account number" />
              <FieldError message={fieldErrors.bankAccountNo} />
            </div>
            <div>
            <input
              name="bankIfsc"
              className={`w-full ${field}`}
              placeholder="IFSC code"
              onChange={(e) => {
                // The IFSC names the bank; fill it in unless the seller already has.
                if (bankNameTouched) return;
                setBankName(bankNameFromIfsc(e.target.value) ?? '');
              }}
            />
            <FieldError message={fieldErrors.bankIfsc} />
            </div>
            <div>
            <input
              name="bankName"
              className={`w-full ${field}`}
              placeholder="Bank name"
              value={bankName}
              onChange={(e) => {
                setBankNameTouched(true);
                setBankName(e.target.value);
              }}
            />
            <FieldError message={fieldErrors.bankName} />
            </div>
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-700">Pickup address</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <input name="addressLine1" className={`w-full ${field}`} placeholder="Address line" />
              <FieldError message={fieldErrors.addressLine1} />
            </div>
            <div>
              <input name="city" className={`w-full ${field}`} placeholder="City" />
              <FieldError message={fieldErrors.city} />
            </div>
            <div>
              <input name="state" className={`w-full ${field}`} placeholder="State" />
              <FieldError message={fieldErrors.state} />
            </div>
            <div>
              <input name="pincode" className={`w-full ${field}`} placeholder="Pincode (6 digits)" />
              <FieldError message={fieldErrors.pincode} />
            </div>
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? <><Spinner className="mr-1" />Submitting…</> : loggedIn ? 'Submit application' : 'Send OTP & Submit'}
        </button>
      </form>
    </main>
  );
}
