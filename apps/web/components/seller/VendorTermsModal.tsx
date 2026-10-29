'use client';

import { useEffect, useState } from 'react';
import { VENDOR_TERMS_ACCEPT_TEXT } from '@clowe/shared';
import Spinner from '@/components/Spinner';

/**
 * The Vendor Terms and Seller Agreement, in full, in a window the seller has
 * to read through and accept — with links to the Terms & Conditions, the
 * Privacy Policy and the Seller Fees. The checkbox starts unticked and the
 * button stays disabled until it is ticked. Used at registration ("Final
 * Submit") and when a seller must accept a new version.
 */
export function VendorTermsModal({
  title,
  intro,
  submitLabel,
  busy,
  error,
  onAccept,
  onClose,
}: {
  title: string;
  intro?: string;
  submitLabel: string;
  busy: boolean;
  error?: string;
  onAccept: (version: string) => void;
  /** Absent: the window cannot be dismissed (accepting is required to go on). */
  onClose?: () => void;
}) {
  const [terms, setTerms] = useState<{ version: string; html: string } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [ticked, setTicked] = useState(false);

  useEffect(() => {
    fetch('/legal/vendor-terms', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((t: { version: string; html: string }) => setTerms(t))
      .catch(() => setLoadError(true));
  }, []);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-modal="true" aria-label={title} data-vendor-terms>
      <div className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white sm:max-w-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 p-4">
          <div>
            <h2 className="font-display text-lg font-bold text-ink-900">{title}</h2>
            {intro && <p className="mt-0.5 text-xs text-gray-500">{intro}</p>}
          </div>
          {onClose && (
            <button onClick={onClose} className="rounded-full p-1 text-xl leading-none text-gray-400 hover:bg-cream-100" aria-label="Close">
              ×
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm" data-vendor-terms-text>
          {terms ? (
            <article dangerouslySetInnerHTML={{ __html: terms.html }} />
          ) : loadError ? (
            <p className="text-red-700">
              The Vendor Terms could not be loaded.{' '}
              <a href="/pages/seller-terms" target="_blank" className="font-semibold underline">
                Read them here
              </a>
              , then try again.
            </p>
          ) : (
            <p className="text-gray-500">Loading the Vendor Terms…</p>
          )}
        </div>
        <div className="border-t border-gray-100 p-4">
          <p className="text-xs text-gray-500">
            Also read:{' '}
            <a href="/pages/seller-terms" target="_blank" className="font-semibold text-brand-600 hover:underline">
              Seller Terms
            </a>
            {' · '}
            <a href="/pages/terms-conditions" target="_blank" className="font-semibold text-brand-600 hover:underline">
              Terms &amp; Conditions
            </a>
            {' · '}
            <a href="/pages/privacy-policy" target="_blank" className="font-semibold text-brand-600 hover:underline">
              Privacy Policy
            </a>
            {' · '}
            <a href="/pages/seller-fees" target="_blank" className="font-semibold text-brand-600 hover:underline">
              Seller Fees
            </a>
          </p>
          <label className="mt-3 flex items-start gap-2 text-sm text-ink-900">
            <input
              type="checkbox"
              name="acceptVendorTerms"
              checked={ticked}
              onChange={(e) => setTicked(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-brand-600"
            />
            <span>{VENDOR_TERMS_ACCEPT_TEXT}</span>
          </label>
          {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
          <button
            onClick={() => terms && onAccept(terms.version)}
            disabled={!ticked || !terms || busy}
            className="mt-3 w-full rounded-lg bg-brand-600 py-2.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? (
              <>
                <Spinner className="mr-1" />
                Submitting…
              </>
            ) : (
              submitLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
