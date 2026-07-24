'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { TryOnQuota, TryOnResult } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser, uploadImages } from '@/lib/api';

interface Props {
  productId: string;
  productTitle: string;
  onClose: () => void;
}

export default function TryOnModal({ productId, productTitle, onClose }: Props) {
  const router = useRouter();
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [quota, setQuota] = useState<TryOnQuota | null>(null);
  const [phase, setPhase] = useState<'pick' | 'generating' | 'done'>('pick');
  const [result, setResult] = useState<TryOnResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getStoredUser()) {
      router.push('/login');
      return;
    }
    api<TryOnQuota>('/api/tryon/quota', { auth: true }).then(setQuota).catch(() => {});
  }, [router]);

  useEffect(() => {
    if (!photoFile) return;
    const url = URL.createObjectURL(photoFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  // No new file picked → fall back to the user's saved try-on photo.
  const savedPhotoUrl = quota?.savedPhotoUrl ?? null;
  const effectivePreview = photoFile ? previewUrl : savedPhotoUrl;

  async function generate() {
    if (!photoFile && !savedPhotoUrl) return;
    setError('');
    setPhase('generating');
    try {
      let photoUrl = savedPhotoUrl!;
      if (photoFile) {
        [photoUrl] = await uploadImages([photoFile]);
        // Remember this photo so next time it's one click.
        void api('/api/tryon/photo', { body: { photoUrl }, auth: true }).catch(() => {});
      }
      const data = await api<TryOnResult>('/api/tryon', {
        body: { productId, photoUrl },
        auth: true,
      });
      if (data.status === 'FAILED') {
        setError(data.errorMessage ?? 'Try-on failed. Please try another photo.');
        setPhase('pick');
        return;
      }
      setResult(data);
      setPhase('done');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setPhase('pick');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold">✨ Try On Me</h2>
            <p className="mt-0.5 text-xs text-gray-500">{productTitle}</p>
          </div>
          <button onClick={onClose} className="text-xl text-gray-400 hover:text-gray-600" aria-label="Close">
            ×
          </button>
        </div>

        {quota && (
          <p className="mt-2 text-xs text-gray-500">
            {Math.max(0, quota.dailyLimit - quota.usedToday)} of {quota.dailyLimit} try-ons left
            today
            {quota.provider === 'mock' && (
              <span className="ml-1 rounded-full bg-yellow-100 px-2 py-0.5 font-semibold text-yellow-700">
                mock mode
              </span>
            )}
          </p>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {phase === 'pick' && (
          <div className="mt-4">
            {effectivePreview ? (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={effectivePreview} alt="Your photo" className="max-h-80 w-full rounded-xl object-contain bg-gray-50" />
                {!photoFile && savedPhotoUrl && (
                  <span className="absolute left-2 top-2 rounded-full bg-green-100 px-2.5 py-1 text-[11px] font-semibold text-green-700 shadow">
                    ✓ Your saved photo
                  </span>
                )}
                <label className="absolute right-2 top-2 cursor-pointer rounded-full bg-white/90 px-3 py-1 text-xs font-semibold shadow hover:bg-white">
                  Change photo
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="user"
                    className="hidden"
                    onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
            ) : (
              <label className="flex h-56 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 text-gray-500 hover:border-brand-600 hover:text-brand-600">
                <span className="text-3xl">📷</span>
                <span className="mt-2 text-sm font-medium">Upload your photo</span>
                <span className="mt-1 text-xs text-gray-400">
                  Full-body, front-facing works best · JPG/PNG, max 5 MB
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="user"
                  className="hidden"
                  onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                />
              </label>
            )}

            <button
              onClick={() => void generate()}
              disabled={!photoFile && !savedPhotoUrl}
              className="mt-4 w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Generate try-on
            </button>
          </div>
        )}

        {phase === 'generating' && (
          <div className="mt-6 flex flex-col items-center py-10">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" />
            <p className="mt-4 text-sm font-medium text-gray-700">Creating your try-on…</p>
            <p className="mt-1 text-xs text-gray-400">This can take up to a minute</p>
          </div>
        )}

        {phase === 'done' && result?.resultImageUrl && (
          <div className="mt-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={result.resultImageUrl}
              alt="Try-on result"
              className="w-full rounded-xl border border-gray-200"
            />
            <p className="mt-2 text-center text-xs text-gray-500">
              Saved to{' '}
              <Link href="/tryon" className="font-semibold text-brand-600 hover:underline">
                My Try-Ons
              </Link>{' '}
              · {result.remainingToday} left today
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  setPhase('pick');
                  setResult(null);
                }}
                className="flex-1 rounded-lg border border-gray-300 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Try another photo
              </button>
              <button
                onClick={onClose}
                className="flex-1 rounded-lg bg-brand-600 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
