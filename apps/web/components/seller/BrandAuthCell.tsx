'use client';

import { useRef, useState } from 'react';
import { BRAND_AUTH_LABELS, BRAND_PROOF_TYPES, BRAND_PROOF_TYPE_LABELS, safeHref, type BrandAuthView, type BrandProofType } from '@clowe/shared';
import { api, ApiRequestError, uploadSellerDocument } from '@/lib/api';

/**
 * A listing of a brand that needs proof (an admin's rule): where this
 * seller's proof for the brand stands, and the upload — an authorization
 * letter, or a GST purchase invoice from the brand or its authorized
 * distributor. One approved proof covers all the seller's listings of the
 * brand; until then they stay hidden from shoppers.
 */
export default function BrandAuthCell({ brandAuth, onChanged }: { brandAuth: BrandAuthView; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [proofType, setProofType] = useState<BrandProofType>('AUTHORIZATION_LETTER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const doc = await uploadSellerDocument(file);
      await api(`/api/seller/brand-proofs/${brandAuth.brandId}`, {
        method: 'PUT',
        auth: true,
        body: { doc: doc.ref, proofType },
        success: `${brandAuth.brandName} proof sent — an admin will review it`,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not upload the proof');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const tone = brandAuth.status === 'APPROVED' ? 'text-green-700' : brandAuth.status === 'REJECTED' || brandAuth.status === 'EXPIRED' ? 'text-red-600' : 'text-amber-700';
  const canUpload = brandAuth.status !== 'PENDING' && brandAuth.status !== 'APPROVED';
  const docHref = safeHref(brandAuth.docUrl);
  return (
    <div className="mt-1 max-w-[18rem] text-[10px]" data-brand-auth={brandAuth.status}>
      <span className={`block font-semibold ${tone}`}>
        {brandAuth.brandName}: {BRAND_AUTH_LABELS[brandAuth.status]}
        {brandAuth.status === 'APPROVED' && brandAuth.expiresAt && ` until ${brandAuth.expiresAt}`}
      </span>
      {brandAuth.note && <span className="block text-red-600">{brandAuth.note}</span>}
      {docHref && (
        <a href={safeHref(brandAuth.docUrl) ?? undefined} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-600 hover:underline">
          View my proof
        </a>
      )}
      {canUpload && (
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <select
            value={proofType}
            onChange={(e) => setProofType(e.target.value as BrandProofType)}
            aria-label="Kind of brand proof"
            className="max-w-[11rem] rounded border border-gray-200 px-1 py-0.5 text-[10px]"
          >
            {BRAND_PROOF_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'AUTHORIZATION_LETTER' ? 'Authorization letter' : 'GST purchase invoice'}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={() => input.current?.click()} className="font-semibold text-brand-600 hover:underline disabled:opacity-50">
            {busy ? 'Uploading…' : 'Upload brand proof'}
          </button>
        </span>
      )}
      {canUpload && <span className="block text-gray-400">{BRAND_PROOF_TYPE_LABELS[proofType]}</span>}
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        className="hidden"
        aria-label="Brand proof document"
        data-brand-auth-file
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      {error && <span className="block text-red-600">{error}</span>}
    </div>
  );
}
