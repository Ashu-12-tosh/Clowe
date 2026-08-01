'use client';

import { useEffect, useState } from 'react';
import {
  AD_DURATIONS,
  AD_PLACEMENTS,
  AD_PLACEMENT_LABELS,
  type PlatformSettings,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

/** Paise → editable rupee string and back. */
const toRupees = (paise: number) => String(Math.round(paise / 100));
const toPaise = (rupees: string) => Math.max(0, Math.round(Number(rupees || '0') * 100));

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [tryonMin, setTryonMin] = useState('');
  const [social, setSocial] = useState({ facebook: '', twitter: '', instagram: '' });
  const [adPrices, setAdPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PlatformSettings>('/api/admin/settings', { auth: true })
      .then((s) => {
        setSettings(s);
        setTryonMin(toRupees(s.tryonMinPricePaise));
        setSocial(s.socialLinks);
        const prices: Record<string, string> = {};
        for (const pl of AD_PLACEMENTS)
          for (const d of AD_DURATIONS)
            prices[`${pl}:${d}`] = toRupees(s.adPricing[pl][String(d) as '7' | '15' | '30']);
        setAdPrices(prices);
      })
      .catch(() => setError('Could not load settings'));
  }, []);

  async function save() {
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      const adPricing = {
        HOME_BANNER: { '7': 0, '15': 0, '30': 0 },
        CATEGORY_SPONSORED: { '7': 0, '15': 0, '30': 0 },
      } as PlatformSettings['adPricing'];
      for (const pl of AD_PLACEMENTS)
        for (const d of AD_DURATIONS)
          adPricing[pl][String(d) as '7' | '15' | '30'] = toPaise(adPrices[`${pl}:${d}`]);

      const fresh = await api<PlatformSettings>('/api/admin/settings', {
        method: 'PUT',
        body: { tryonMinPricePaise: toPaise(tryonMin), socialLinks: social, adPricing },
        auth: true,
      });
      setSettings(fresh);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  }

  if (!settings && !error) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-1 text-sm text-gray-500">Platform-wide controls — saved instantly for the whole site.</p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {saved && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          ✓ Settings saved
        </div>
      )}

      {/* Try-On */}
      <div className="mt-5 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">✨ AI Try-On</h2>
        <label className="mt-3 block text-sm font-medium">Minimum product price for Try-On (₹)</label>
        <input
          type="number"
          min={0}
          value={tryonMin}
          onChange={(e) => setTryonMin(e.target.value)}
          className={`mt-1 ${field}`}
        />
        <p className="mt-1 text-xs text-gray-400">
          The Try On Me button appears only on products at or above this price. Enforced server-side too.
        </p>
      </div>

      {/* Social links */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">🔗 Social links (footer)</h2>
        <p className="mt-1 text-xs text-gray-400">Leave empty to show a &ldquo;Coming soon&rdquo; state instead of a dead link.</p>
        {(['facebook', 'twitter', 'instagram'] as const).map((key) => (
          <div key={key} className="mt-3">
            <label className="block text-sm font-medium capitalize">{key}</label>
            <input
              type="url"
              value={social[key]}
              onChange={(e) => setSocial((s) => ({ ...s, [key]: e.target.value }))}
              placeholder={`https://${key}.com/clowe`}
              className={`mt-1 ${field}`}
            />
          </div>
        ))}
      </div>

      {/* Ad pricing */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">📣 Ad pricing (₹, per placement & duration)</h2>
        {AD_PLACEMENTS.map((pl) => (
          <div key={pl} className="mt-3">
            <p className="text-sm font-medium">{AD_PLACEMENT_LABELS[pl]}</p>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {AD_DURATIONS.map((d) => (
                <div key={d}>
                  <label className="text-xs text-gray-500">{d} days</label>
                  <input
                    type="number"
                    min={0}
                    value={adPrices[`${pl}:${d}`] ?? ''}
                    onChange={(e) => setAdPrices((p) => ({ ...p, [`${pl}:${d}`]: e.target.value }))}
                    className={field}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => void save()}
        disabled={busy}
        className="mt-5 w-full rounded-xl bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50 sm:w-auto sm:px-10"
      >
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  );
}
