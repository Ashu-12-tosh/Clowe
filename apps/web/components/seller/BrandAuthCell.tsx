'use client';

import { useRef, useState } from 'react';
import { BRAND_AUTH_LABELS, safeHref, type BrandAuthView } from '@clowe/shared';
import { api, ApiRequestError, uploadSellerDocument } from '@/lib/api';

/**
 * A listing of a brand that needs authorization (an admin's rule): where its
 * document stands, and the upload. Until an admin approves the document the
 * listing stays hidden from shoppers.
 */
export default function BrandAuthCell({ productId, brandAuth, onChanged }: { productId: string; brandAuth: BrandAuthView; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const doc = await uploadSellerDocument(file);
      await api(`/api/seller/products/${productId}/brand-authorization`, {
        method: 'PUT',
        auth: true,
        body: { doc: doc.ref },
        success: 'Document sent — an admin will review it',
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not upload the document');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const tone = brandAuth.status === 'APPROVED' ? 'text-green-700' : brandAuth.status === 'REJECTED' ? 'text-red-600' : 'text-amber-700';
  return (
    <div className="mt-1 max-w-[16rem] text-[10px]" data-brand-auth={brandAuth.status}>
      <span className={`block font-semibold ${tone}`}>{BRAND_AUTH_LABELS[brandAuth.status]}</span>
      {brandAuth.note && <span className="block text-red-600">{brandAuth.note}</span>}
      <span className="mt-0.5 flex flex-wrap gap-x-2">
        {safeHref(brandAuth.docUrl) && (
          <a href={safeHref(brandAuth.docUrl) ?? undefined} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-600 hover:underline">
            View document
          </a>
        )}
        {brandAuth.status !== 'APPROVED' && brandAuth.status !== 'PENDING' && (
          <button type="button" disabled={busy} onClick={() => input.current?.click()} className="font-semibold text-brand-600 hover:underline disabled:opacity-50">
            {busy ? 'Uploading…' : brandAuth.docUrl ? 'Upload a new document' : 'Upload brand authorization'}
          </button>
        )}
      </span>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        className="hidden"
        aria-label="Brand authorization document"
        data-brand-auth-file
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      {error && <span className="block text-red-600">{error}</span>}
    </div>
  );
}
