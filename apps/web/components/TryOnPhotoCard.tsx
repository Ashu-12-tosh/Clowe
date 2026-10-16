'use client';

import { useEffect, useState } from 'react';
import type { TryOnQuota } from '@clowe/shared';
import { api, ApiRequestError, uploadPrivateImages } from '@/lib/api';
import { toast } from '@/lib/toast';
import { TryOnConsentBox, useTryOnConsent } from '@/components/TryOnConsent';

/**
 * Account-page card: upload your try-on photo once — every "✨ Try On Me"
 * then uses it automatically.
 */
export default function TryOnPhotoCard() {
  const consent = useTryOnConsent();
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<TryOnQuota>('/api/tryon/quota', { auth: true })
      .then((q) => setPhotoUrl(q.savedPhotoUrl))
      .catch(() => {});
  }, []);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      await consent.ensure();
      const [photo] = await uploadPrivateImages([file], 'TRYON_PHOTO');
      await api('/api/tryon/photo', { body: { photoRef: photo.ref }, auth: true });
      setPhotoUrl(photo.url);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  /** Withdraw the try-on consent: every try-on photo is deleted now. */
  async function withdraw() {
    if (!window.confirm('Delete all your try-on photos and withdraw your consent? AI Try-On will ask again before you use it.')) return;
    setBusy(true);
    try {
      await api('/api/tryon/consent', { method: 'DELETE', auth: true, success: 'Your try-on photos are deleted and your consent withdrawn' });
      setPhotoUrl(null);
      consent.setTicked(false);
      window.location.reload();
    } catch {
      toast.error('Could not delete your try-on photos — try again');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api('/api/tryon/photo', { method: 'DELETE', auth: true });
      setPhotoUrl(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">✨ My Try-On Photo</p>
        {photoUrl && (
          <button onClick={() => void remove()} disabled={busy} className="text-xs text-red-500 hover:underline">
            Remove
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Upload a photo — every &ldquo;Try On Me&rdquo; uses it for the next 24 hours.
      </p>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-3 flex items-center gap-3">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl} alt="Your try-on photo" className="h-24 w-20 rounded-lg border border-gray-200 object-cover" />
        ) : (
          <div className="flex h-24 w-20 items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-2xl text-gray-300">
            📷
          </div>
        )}
        <label className="cursor-pointer rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:border-brand-600 hover:text-brand-600">
          {busy ? 'Uploading…' : photoUrl ? 'Replace photo' : 'Upload photo'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="user"
            className="hidden"
            disabled={busy || !consent.ready}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {consent.consented === false && <TryOnConsentBox ticked={consent.ticked} onChange={consent.setTicked} />}
      <p className="mt-3 text-[11px] text-gray-500">Try-on photos are deleted 24 hours after upload.</p>
      {consent.consented && (
        <button
          onClick={() => void withdraw()}
          disabled={busy}
          className="mt-2 text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
        >
          Delete my try-on photos / withdraw consent
        </button>
      )}
    </div>
  );
}
