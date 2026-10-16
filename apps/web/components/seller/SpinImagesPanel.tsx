'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, ApiRequestError, uploadImages } from '@/lib/api';
import SpinViewer from '@/components/SpinViewer';

/**
 * The 360° view for one product (Pro and Premium plans): upload photos taken
 * all the way around it, in order — 24 to 36 work best — and preview the spin.
 */
export function SpinImagesPanel({ productId, initial, pending: pendingAtLoad = [] }: { productId: string; initial: string[]; pending?: string[] }) {
  const [live, setLive] = useState<string[]>(initial);
  // New photos wait for Clowe's review; the live view stays until then.
  const [pending, setPending] = useState<string[]>(pendingAtLoad);
  const images = pending.length ? pending : live;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(next: string[]) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/seller/products/${productId}/spin-images`, { method: 'PUT', auth: true, quiet: true, body: { imageUrls: next }, success: next.length ? '360° view sent for review' : '360° view removed' });
      if (next.length) setPending(next);
      else {
        setLive([]);
        setPending([]);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the 360° view');
    } finally {
      setBusy(false);
    }
  }

  async function add(files: FileList | null) {
    if (!files?.length) return;
    // Uploaded in the order the files are named, which is the order a turntable shoot produces.
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setBusy(true);
    try {
      const urls = await uploadImages(sorted);
      await save([...images, ...urls]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not upload the photos');
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 max-w-3xl rounded-2xl border border-gray-100 bg-white p-4" data-spin-panel>
      <h2 className="text-sm font-bold text-ink-900">360° product view</h2>
      <p className="text-xs text-gray-500">
        Photos taken all the way around the product, in order (24–36 work best). Shoppers drag to turn it. With the Pro and Premium{' '}
        <Link href="/seller/plans" className="font-semibold text-brand-600 hover:underline">
          plans
        </Link>
        .
      </p>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {pending.length > 0 && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-spin-pending>
          Waiting for review — checked like product photos before shoppers see it.{live.length ? ' Your current 360° view stays live until then.' : ''}
        </p>
      )}
      {images.length >= 2 && (
        <div className="mt-3 max-w-xs">
          <SpinViewer images={images} alt="Preview" />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold">
          {busy ? 'Working…' : images.length ? `Add photos (${images.length} so far)` : 'Upload photos'}
          <input type="file" name="spinImages" accept="image/jpeg,image/png,image/webp" multiple className="hidden" disabled={busy} onChange={(e) => void add(e.target.files)} />
        </label>
        {images.length > 0 && (
          <button onClick={() => void save([])} disabled={busy} className="text-xs font-semibold text-red-600 disabled:opacity-50">
            Remove the 360° view
          </button>
        )}
      </div>
    </section>
  );
}
