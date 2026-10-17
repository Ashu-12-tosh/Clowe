'use client';

import { useEffect, useRef, useState } from 'react';
import {
  BANK_ACCOUNT_TYPES,
  BANK_ACCOUNT_TYPE_LABELS,
  KYC_CHECK_STATE_LABELS,
  sellerBankAccountSchema,
  type BankAccountType,
  type SellerKycStatus,
  type SellerStoreSettings,
} from '@clowe/shared';
import { api, ApiRequestError, uploadSellerDocument } from '@/lib/api';
import Spinner from '@/components/Spinner';

const field = 'mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm';

/**
 * The seller's bank account for payouts: holder name, the account number
 * twice, IFSC, account type and a cancelled cheque. Stored encrypted and
 * shown by its last 4 digits; "Pending review" until Clowe verifies it
 * against the cheque (or, later, the bank confirms it).
 */
export default function BankAccountForm({ settings, onSaved }: { settings: SellerStoreSettings; onSaved: () => void }) {
  const [status, setStatus] = useState<SellerKycStatus | null>(null);
  const [editing, setEditing] = useState(!settings.bankAccountLast4);
  const [form, setForm] = useState({ accountName: settings.bankAccountName ?? '', accountNumber: '', confirmAccountNumber: '', ifsc: settings.bankIfsc ?? '', accountType: (settings.bankAccountType as BankAccountType) ?? 'CURRENT', bankName: settings.bankName ?? '' });
  const [cheque, setCheque] = useState<{ ref: string; name: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<SellerKycStatus>('/api/seller/kyc', { auth: true }).then(setStatus).catch(() => {});
  }, [settings]);

  async function uploadCheque(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    setError('');
    try {
      const doc = await uploadSellerDocument(f);
      setCheque({ ref: doc.ref, name: f.name });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not upload the cheque');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = sellerBankAccountSchema.safeParse({ ...form, chequeDoc: cheque?.ref ?? '' });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    setError('');
    try {
      await api('/api/seller/store/bank', { method: 'PUT', auth: true, body: parsed.data, success: 'Bank account saved — Clowe will verify it against your cheque' });
      setEditing(false);
      setCheque(null);
      setForm((f) => ({ ...f, accountNumber: '', confirmAccountNumber: '' }));
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the bank account');
    } finally {
      setBusy(false);
    }
  }

  const bank = status?.bank;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4" data-bank-account>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-ink-900">Bank account for payouts</h2>
          <p className="text-[11px] text-gray-400">Your payouts go here once Clowe has verified it against your cancelled cheque.</p>
        </div>
        {bank && settings.bankAccountLast4 && (
          <span
            data-bank-state={bank.state}
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              bank.state === 'VERIFIED' ? 'bg-green-100 text-green-700' : bank.state === 'REJECTED' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
            }`}
          >
            {KYC_CHECK_STATE_LABELS[bank.state]}
          </span>
        )}
      </div>

      {settings.bankAccountLast4 && !editing && (
        <>
          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex justify-between"><dt className="text-gray-500">Account holder</dt><dd className="text-ink-900">{settings.bankAccountName ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Account number</dt><dd className="font-mono text-ink-900">•••• •••• {settings.bankAccountLast4}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">IFSC</dt><dd className="font-mono text-ink-900">{settings.bankIfsc ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Type</dt><dd className="text-ink-900">{settings.bankAccountType ? BANK_ACCOUNT_TYPE_LABELS[settings.bankAccountType as BankAccountType] : '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Cancelled cheque</dt><dd className="text-ink-900">{settings.bankChequeOnFile ? 'On file' : 'Not uploaded'}</dd></div>
          </dl>
          {bank?.state === 'REJECTED' && bank.rejectReason && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">Not accepted: {bank.rejectReason}</p>}
          {bank && bank.state !== 'VERIFIED' && bank.state !== 'REJECTED' && (
            <p className="mt-2 text-[11px] text-gray-500">Pending review — Clowe checks it against your cancelled cheque. Payouts start once it is verified.</p>
          )}
          <button type="button" onClick={() => setEditing(true)} className="mt-3 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50">
            Change bank account
          </button>
        </>
      )}

      {editing && (
        <form onSubmit={(e) => void save(e)} noValidate className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-gray-600 sm:col-span-2">
            Account holder name
            <input name="accountName" value={form.accountName} onChange={set('accountName')} className={field} autoComplete="off" />
            {errors.accountName && <span className="text-[11px] font-normal text-red-600">{errors.accountName}</span>}
          </label>
          <label className="text-xs font-semibold text-gray-600">
            Account number
            <input name="accountNumber" value={form.accountNumber} onChange={set('accountNumber')} inputMode="numeric" autoComplete="off" className={field} />
            {errors.accountNumber && <span className="text-[11px] font-normal text-red-600">{errors.accountNumber}</span>}
          </label>
          <label className="text-xs font-semibold text-gray-600">
            Account number again
            <input
              name="confirmAccountNumber"
              value={form.confirmAccountNumber}
              onChange={set('confirmAccountNumber')}
              onPaste={(e) => e.preventDefault()}
              inputMode="numeric"
              autoComplete="off"
              className={field}
            />
            {errors.confirmAccountNumber && <span className="text-[11px] font-normal text-red-600">{errors.confirmAccountNumber}</span>}
          </label>
          <label className="text-xs font-semibold text-gray-600">
            IFSC
            <input name="ifsc" value={form.ifsc} onChange={(e) => setForm((f) => ({ ...f, ifsc: e.target.value.toUpperCase() }))} placeholder="HDFC0001234" className={`${field} font-mono`} autoComplete="off" />
            {errors.ifsc && <span className="text-[11px] font-normal text-red-600">{errors.ifsc}</span>}
          </label>
          <label className="text-xs font-semibold text-gray-600">
            Account type
            <select name="accountType" value={form.accountType} onChange={set('accountType')} className={field}>
              {BANK_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>{BANK_ACCOUNT_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-gray-600 sm:col-span-2">
            Bank name (optional)
            <input name="bankName" value={form.bankName} onChange={set('bankName')} className={field} />
          </label>
          <div className="text-xs sm:col-span-2">
            <p className="font-semibold text-gray-600">Cancelled cheque</p>
            <p className="text-[11px] text-gray-400">A cheque from this account with &quot;CANCELLED&quot; written across it, showing the name, account number and IFSC (PDF or photo).</p>
            <button type="button" disabled={busy} onClick={() => file.current?.click()} className="mt-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50">
              {cheque ? `✓ ${cheque.name} — replace` : 'Upload cancelled cheque'}
            </button>
            <input ref={file} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" aria-label="Cancelled cheque" data-cheque-file onChange={(e) => void uploadCheque(e.target.files?.[0])} />
            {errors.chequeDoc && <p className="text-[11px] text-red-600">{errors.chequeDoc}</p>}
          </div>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 sm:col-span-2">{error}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50">
              {busy && <Spinner className="mr-1" />}Save bank account
            </button>
            {settings.bankAccountLast4 && (
              <button type="button" onClick={() => setEditing(false)} className="px-3 text-xs font-semibold text-gray-500">
                Cancel
              </button>
            )}
          </div>
          <p className="text-[11px] text-gray-400 sm:col-span-2">Stored encrypted. Only the last 4 digits are ever shown. A new account is checked again before payouts go to it.</p>
        </form>
      )}
    </section>
  );
}
