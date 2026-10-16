'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { TRYON_CONSENT_TEXT, type TryOnQuota } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';

/**
 * The try-on consent (Privacy Policy 3): an unchecked box, "I am 18+ and this
 * photo is of me or of an adult who has consented", that has to be ticked
 * before the first try-on photo is uploaded or used. Once given it is stored
 * (time and wording) and not asked again; withdrawing it in Account settings
 * deletes the photos and asks again next time.
 */
export function useTryOnConsent() {
  const [consented, setConsented] = useState<boolean | null>(null);
  const [ticked, setTicked] = useState(false);

  useEffect(() => {
    if (!getStoredUser()) {
      setConsented(false);
      return;
    }
    api<TryOnQuota>('/api/tryon/quota', { auth: true })
      .then((q) => setConsented(q.consented))
      .catch(() => setConsented(false));
  }, []);

  /** Before an upload or a try-on: records the consent the first time. */
  const ensure = useCallback(async () => {
    if (consented) return;
    if (!ticked) throw new ApiRequestError('TRYON_CONSENT_REQUIRED', 'Please tick the box to confirm you are 18+ and the photo is of you or of a consenting adult');
    await api('/api/tryon/consent', { body: { accepted: true }, auth: true, quiet: true });
    setConsented(true);
  }, [consented, ticked]);

  return { consented, ticked, setTicked, ready: consented === true || ticked, ensure };
}

/** The box itself — shown only while consent has not been given. */
export function TryOnConsentBox({ ticked, onChange }: { ticked: boolean; onChange: (ticked: boolean) => void }) {
  return (
    <label className="mt-3 flex items-start gap-2 rounded-lg bg-cream-50 p-2.5 text-xs text-gray-700" data-tryon-consent>
      <input
        type="checkbox"
        name="tryOnConsent"
        checked={ticked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
      />
      <span>
        {TRYON_CONSENT_TEXT}. The photo is used only to make my try-on images and is deleted 24 hours after upload —{' '}
        <Link href="/pages/privacy-policy" className="font-semibold text-brand-600 hover:underline">
          Privacy Policy
        </Link>
        .
      </span>
    </label>
  );
}
