'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SELLER_DOCUMENT_LABELS, type LegalEntity, type SellerProfileInfo } from '@clowe/shared';
import { api, ApiRequestError, uploadSellerDocument } from '@/lib/api';
import { getPublicSettings } from '@/lib/settings';
import Spinner from '@/components/Spinner';

type DocKey = keyof typeof SELLER_DOCUMENT_LABELS;

/**
 * What a seller whose application is not approved sees — instead of the
 * dashboard: Pending, Needs more info (with a way to send it), or Rejected
 * with the reason. Support contact on every one.
 */
export function ApplicationStatus({ profile, onChanged }: { profile: SellerProfileInfo; onChanged: () => void }) {
  const [legal, setLegal] = useState<LegalEntity | null>(null);
  const [docs, setDocs] = useState<Partial<Record<DocKey, string>>>({});
  const [uploading, setUploading] = useState<DocKey | null>(null);
  const [gstNumber, setGstNumber] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getPublicSettings()
      .then((s) => setLegal({ ...s.legalEntity, supportEmail: s.supportEmails?.vendor || s.legalEntity.supportEmail }) /* seller help: vendor-support@ */)
      .catch(() => {});
  }, []);

  const needsInfo = profile.status === 'PENDING' && !!profile.infoRequest;
  const state = profile.status === 'REJECTED' ? 'Rejected' : needsInfo ? 'Needs more info' : 'Pending review';

  async function upload(key: DocKey, file: File | undefined) {
    if (!file) return;
    setUploading(key);
    setError('');
    try {
      const u = await uploadSellerDocument(file);
      setDocs((d) => ({ ...d, [key]: u.ref }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not upload that file');
    } finally {
      setUploading(null);
    }
  }

  async function send() {
    setBusy(true);
    setError('');
    try {
      await api('/api/seller/application', {
        auth: true,
        quiet: true,
        body: { ...docs, ...(gstNumber.trim() ? { gstNumber: gstNumber.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send it');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-10" data-application-status={state}>
      <h1 className="font-display text-2xl font-bold text-ink-900">Your seller application</h1>
      <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-600">
            <span className="font-semibold text-ink-900">{profile.shopName}</span> ·{' '}
            <span className="font-mono">{profile.applicationId}</span>
          </p>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              profile.status === 'REJECTED' ? 'bg-red-50 text-red-700' : needsInfo ? 'bg-amber-50 text-amber-800' : 'bg-blue-50 text-blue-700'
            }`}
          >
            {state}
          </span>
        </div>
        {profile.applicationSubmittedAt && (
          <p className="mt-1 text-xs text-gray-500">
            Submitted on {new Date(profile.applicationSubmittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          </p>
        )}

        {profile.status === 'REJECTED' ? (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            Your application was not approved{profile.rejectionReason ? `: ${profile.rejectionReason}` : '.'}
          </p>
        ) : needsInfo ? (
          <div className="mt-4 space-y-3">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">We need a little more before we can decide: {profile.infoRequest}</p>
            {(Object.keys(SELLER_DOCUMENT_LABELS) as DocKey[]).map((key) => (
              <div key={key}>
                <p className="text-xs font-semibold text-gray-700">{SELLER_DOCUMENT_LABELS[key]} — upload again if asked</p>
                <div className="mt-1 flex items-center gap-2">
                  <input type="file" name={key} accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => void upload(key, e.target.files?.[0])} className="block w-full text-xs" />
                  {uploading === key && <Spinner />}
                  {docs[key] && <span className="text-xs font-semibold text-green-700">✓</span>}
                </div>
              </div>
            ))}
            <input
              name="gstNumber"
              value={gstNumber}
              onChange={(e) => setGstNumber(e.target.value.toUpperCase())}
              placeholder="GSTIN (if asked)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm uppercase"
            />
            <textarea
              name="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Anything to add for the reviewer"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            {error && <p className="text-xs text-red-700">{error}</p>}
            <button
              onClick={() => void send()}
              disabled={busy || uploading !== null}
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send for review'}
            </button>
          </div>
        ) : (
          <p className="mt-4 text-sm text-gray-700">
            Thank you — our team is reviewing your application. We&apos;ll notify you by SMS and e-mail as soon as it is decided. Your dashboard
            opens once it is approved.
          </p>
        )}
      </div>
      <p className="mt-4 text-center text-xs text-gray-500">
        Questions? Write to {legal?.supportEmail || 'support'}, quoting {profile.applicationId}.{' '}
        <Link href="/" className="font-semibold text-brand-600 hover:underline">
          Back to the store
        </Link>
      </p>
    </main>
  );
}
