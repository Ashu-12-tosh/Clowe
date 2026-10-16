'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  bankNameFromIfsc,
  SELLER_DOCUMENT_LABELS,
  sellerApplicationSchema,
  type AuthTokensResponse,
  type LegalEntity,
  type OtpRequestResult,
  type SellerProfileInfo,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser, refreshSession, saveSession, uploadSellerDocument } from '@/lib/api';
import { issuesToFieldErrors, useFieldErrors } from '@/lib/fieldErrors';
import { getPublicSettings } from '@/lib/settings';
import { toast } from '@/lib/toast';
import FieldError from '@/components/FieldError';
import Spinner from '@/components/Spinner';
import { useSeller } from '@/components/seller/SellerContext';
import ResendOtp from '@/components/auth/ResendOtp';
import { VendorTermsModal } from '@/components/seller/VendorTermsModal';

const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

type DocKey = keyof typeof SELLER_DOCUMENT_LABELS;
const DOCS: { key: DocKey; hint: string; required: boolean }[] = [
  { key: 'constitutionDoc', hint: 'Certificate of incorporation, partnership deed, LLP agreement or proprietorship declaration', required: true },
  { key: 'cancelledChequeDoc', hint: 'A cancelled cheque of the bank account below', required: true },
  { key: 'signatoryKycDoc', hint: "The authorised signatory's Aadhaar, passport, voter ID or driving licence", required: true },
  { key: 'brandAuthorisationDoc', hint: 'Trade mark registration or a brand / reseller authorisation letter, for branded goods', required: false },
];

/**
 * Become a seller: verify the phone, fill in the business details and the
 * Vendor Terms 2.1 documents, read and accept the Vendor Terms in full, and
 * submit. The application is then reviewed — the dashboard opens only once
 * it is approved.
 */
export default function SellerRegisterPage() {
  const router = useRouter();
  const { state, reload } = useSeller();
  const [step, setStep] = useState<'phone' | 'otp' | 'form' | 'submitted'>(() =>
    typeof window !== 'undefined' && getStoredUser() ? 'form' : 'phone',
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { errors: fieldErrors, show: showFieldErrors, fromError } = useFieldErrors();

  // Phone verification (guests): the account the shop belongs to.
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [otpSent, setOtpSent] = useState<{ result: OtpRequestResult; n: number } | null>(null);

  // The application.
  const [values, setValues] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<Partial<Record<DocKey, { ref: string; name: string }>>>({});
  const [uploading, setUploading] = useState<DocKey | null>(null);
  const [bankNameTouched, setBankNameTouched] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState<SellerProfileInfo | null>(null);
  const [legal, setLegal] = useState<LegalEntity | null>(null);

  useEffect(() => {
    getPublicSettings()
      .then((s) => setLegal({ ...s.legalEntity, supportEmail: s.supportEmails?.vendor || s.legalEntity.supportEmail }) /* seller help: vendor-support@ */)
      .catch(() => {});
  }, []);

  // Already has a shop (and not just now): the seller pages show where it stands.
  useEffect(() => {
    if (state.kind === 'ready' && step !== 'submitted') router.replace('/seller');
  }, [state, step, router]);

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[6-9]\d{9}$/.test(phone)) {
      showFieldErrors({ phone: 'Enter a valid 10-digit mobile number' });
      return;
    }
    setBusy(true);
    setError('');
    try {
      const otp = await api<OtpRequestResult>('/api/auth/request-otp', { body: { phone } });
      setDevOtp(otp.devOtp ?? '');
      setCode(otp.devOtp ?? '');
      setOtpSent((prev) => ({ result: otp, n: (prev?.n ?? 0) + 1 }));
      setStep('otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await api<AuthTokensResponse>('/api/auth/verify-otp', { body: { phone, code } });
      saveSession(data);
      setStep('form');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
    } finally {
      setBusy(false);
    }
  }

  async function upload(key: DocKey, file: File | undefined) {
    if (!file) return;
    setUploading(key);
    try {
      const uploaded = await uploadSellerDocument(file);
      setDocs((d) => ({ ...d, [key]: { ref: uploaded.ref, name: file.name } }));
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : 'Could not upload that file');
    } finally {
      setUploading(null);
    }
  }

  /** Everything the application needs, as the API will check it. */
  function application(version: string) {
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''));
    const docRefs = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v!.ref]));
    return { ...filled, ...docRefs, acceptVendorTerms: true as const, vendorTermsVersion: version };
  }

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const parsed = sellerApplicationSchema.safeParse(application('check'));
    if (showFieldErrors(parsed.success ? {} : issuesToFieldErrors(parsed.error.issues))) {
      toast.error('Fix the fields marked in red');
      return;
    }
    setSubmitError('');
    setReviewing(true);
  }

  async function finalSubmit(version: string) {
    setBusy(true);
    setSubmitError('');
    try {
      const profile = await api<SellerProfileInfo>('/api/seller/register', { body: application(version), auth: true, quiet: true });
      await refreshSession(); // role is SELLER now
      setSubmitted(profile);
      setReviewing(false);
      setStep('submitted');
      reload();
    } catch (err) {
      fromError(err);
      setSubmitError(err instanceof ApiRequestError ? err.message : 'Could not submit the application');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- Submitted ----------------
  if (step === 'submitted' && submitted) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12 text-center" data-application-submitted>
        <p className="text-4xl">✅</p>
        <h1 className="mt-3 font-display text-2xl font-bold text-ink-900">Application submitted</h1>
        <p className="mt-2 text-sm text-gray-600">
          Your application number is <span className="font-mono font-bold text-ink-900">{submitted.applicationId}</span>.
        </p>
        <p className="mt-2 text-sm text-gray-600">We&apos;ll review it and notify you by SMS and e-mail. You can list products once it is approved.</p>
        <p className="mt-4 text-xs text-gray-500">
          Questions? {legal?.supportEmail ? <span className="font-semibold text-ink-900">{legal.supportEmail}</span> : 'Use the support chat'}
          {legal?.supportPhone ? <> · {legal.supportPhone}</> : null}
        </p>
        <Link href="/" className="mt-6 inline-block rounded-lg border border-gray-300 px-5 py-2 text-sm font-semibold text-ink-900 hover:border-brand-600">
          Back to the store
        </Link>
      </main>
    );
  }

  // ---------------- Phone (guests) ----------------
  if (step === 'phone' || step === 'otp') {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-2xl font-bold">Become a Clowe seller</h1>
        <p className="mt-1 text-sm text-gray-600">First, verify the mobile number your shop will belong to.</p>
        <p className="mt-1 text-xs text-gray-500">
          Already a seller?{' '}
          <Link href="/seller/login" className="font-semibold text-brand-600 hover:underline">
            Seller login →
          </Link>
        </p>
        {devOtp && step === 'otp' && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            <span className="font-semibold">Dev mode:</span> your OTP is <span className="font-mono text-base font-bold tracking-widest">{devOtp}</span>
          </div>
        )}
        {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {step === 'phone' ? (
          <form className="mt-5 space-y-4" onSubmit={(e) => void sendOtp(e)}>
            <div className="flex overflow-hidden rounded-lg border border-gray-300 bg-white focus-within:border-brand-600">
              <span className="flex items-center border-r border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">+91</span>
              <input
                name="phone"
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                placeholder="10-digit mobile number"
                className="w-full px-3 py-2 text-sm outline-none"
              />
            </div>
            <FieldError message={fieldErrors.phone} />
            <button type="submit" disabled={busy} className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {busy ? <><Spinner className="mr-1" />Sending…</> : 'Send OTP'}
            </button>
          </form>
        ) : (
          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyOtp();
            }}
          >
            <p className="text-sm text-gray-600">
              Code sent to +91 {phone}{' '}
              <button type="button" onClick={() => setStep('phone')} className="text-brand-600 hover:underline">
                change
              </button>
            </p>
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
            <button type="submit" disabled={busy || code.length !== 6} className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {busy ? <><Spinner className="mr-1" />Verifying…</> : 'Verify & continue'}
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
      </main>
    );
  }

  // ---------------- Application ----------------
  const input = (name: string, placeholder: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <input name={name} value={values[name] ?? ''} onChange={(e) => set(name, e.target.value)} placeholder={placeholder} className={field} {...extra} />
      <FieldError message={fieldErrors[name]} />
    </div>
  );

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="text-2xl font-bold">Become a Clowe seller</h1>
      <p className="mt-1 text-sm text-gray-600">
        Tell us about your business and add the documents the Vendor Terms ask for. Our team reviews every application before you can list
        products.
      </p>
      {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <form className="mt-6 space-y-4" onSubmit={review} noValidate>
        <div>
          <label className="text-sm font-medium">Shop name *</label>
          <div className="mt-1">{input('shopName', 'e.g. Ashu Electronics')}</div>
        </div>
        <div>
          <label className="text-sm font-medium">About your shop</label>
          <textarea name="description" rows={2} value={values.description ?? ''} onChange={(e) => set('description', e.target.value)} className={`mt-1 ${field}`} placeholder="What do you sell?" />
        </div>
        <div>
          <label className="text-sm font-medium">Seller referral code (optional)</label>
          <div className="mt-1">{input('referralCode', 'SLR-XXXXXX', { maxLength: 10, className: `${field} uppercase` })}</div>
        </div>

        <fieldset className="rounded-lg border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-700">Tax and bank details</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {input('panNumber', 'PAN *')}
            {input('gstNumber', 'GSTIN (where registered)')}
            {input('bankAccountName', 'Name on the bank account *')}
            {input('bankAccountNo', 'Account number *', { inputMode: 'numeric' })}
            <div>
              <input
                name="bankIfsc"
                value={values.bankIfsc ?? ''}
                onChange={(e) => {
                  set('bankIfsc', e.target.value.toUpperCase());
                  if (!bankNameTouched) set('bankName', bankNameFromIfsc(e.target.value) ?? '');
                }}
                placeholder="IFSC *"
                className={`${field} uppercase`}
              />
              <FieldError message={fieldErrors.bankIfsc} />
            </div>
            <div>
              <input
                name="bankName"
                value={values.bankName ?? ''}
                onChange={(e) => {
                  setBankNameTouched(true);
                  set('bankName', e.target.value);
                }}
                placeholder="Bank name *"
                className={field}
              />
              <FieldError message={fieldErrors.bankName} />
            </div>
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-700">Principal place of business</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">{input('addressLine1', 'Address *')}</div>
            {input('city', 'City *')}
            {input('state', 'State *')}
            {input('pincode', 'PIN code *', { inputMode: 'numeric', maxLength: 6 })}
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-gray-200 p-4">
          <legend className="px-1 text-sm font-semibold text-gray-700">Documents (Vendor Terms 2.1) — PDF or photo, up to 10 MB</legend>
          <div className="space-y-3">
            {DOCS.map((d) => (
              <div key={d.key}>
                <p className="text-sm font-medium text-ink-900">
                  {SELLER_DOCUMENT_LABELS[d.key].replace(' (optional)', '')} {d.required ? <span className="text-red-600">*</span> : <span className="text-xs font-normal text-gray-400">(optional)</span>}
                </p>
                <p className="text-xs text-gray-500">{d.hint}</p>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="file"
                    name={d.key}
                    accept="application/pdf,image/jpeg,image/png,image/webp"
                    onChange={(e) => void upload(d.key, e.target.files?.[0])}
                    className="block w-full text-xs"
                  />
                  {uploading === d.key && <Spinner />}
                  {docs[d.key] && <span className="shrink-0 text-xs font-semibold text-green-700">✓ uploaded</span>}
                </div>
                <FieldError message={fieldErrors[d.key]} />
              </div>
            ))}
          </div>
        </fieldset>

        <button type="submit" disabled={busy || uploading !== null} className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          Submit
        </button>
        <p className="text-center text-xs text-gray-500">Next, you&apos;ll read and accept the Vendor Terms &amp; Seller Agreement.</p>
      </form>

      {reviewing && (
        <VendorTermsModal
          title="Vendor Terms & Seller Agreement"
          intro="Please read the agreement in full before you submit your application."
          submitLabel="Final Submit"
          busy={busy}
          error={submitError}
          onAccept={(version) => void finalSubmit(version)}
          onClose={() => setReviewing(false)}
        />
      )}
    </main>
  );
}
