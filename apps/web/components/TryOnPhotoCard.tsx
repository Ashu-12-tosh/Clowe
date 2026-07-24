'use client';

import { useEffect, useState } from 'react';
import type { TryOnQuota } from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';

/**
 * Account-page card: upload your try-on photo once — every "✨ Try On Me"
 * then uses it automatically.
 */
export default function TryOnPhotoCard() {
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
      const [url] = await uploadImages([file]);
      await api('/api/tryon/photo', { body: { photoUrl: url }, auth: true });
      setPhotoUrl(url);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
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
        Upload once — every &ldquo;Try On Me&rdquo; uses this photo automatically.
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
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}
