'use client';

import { useState } from 'react';
import type { AdminTryOnSettings, AdminTryOnSettingsInput } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

export type SettingsMode = 'MODEL' | 'LIMITS';

/**
 * Model Settings / Usage Limits. Both write to platform settings, and the
 * storefront try-on route reads them on every run — so changes take effect
 * immediately, no redeploy.
 */
export default function SettingsModal({
  mode,
  settings,
  onClose,
  onSaved,
}: {
  mode: SettingsMode;
  settings: AdminTryOnSettings;
  onClose: () => void;
  onSaved: (next: AdminTryOnSettings) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [dailyLimit, setDailyLimit] = useState(String(settings.dailyLimitPerUser));
  const [minPrice, setMinPrice] = useState(String(Math.round(settings.minPricePaise / 100)));
  const [budget, setBudget] = useState(String(Math.round(settings.monthlyBudgetPaise / 100)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body: AdminTryOnSettingsInput =
        mode === 'MODEL'
          ? { enabled, monthlyBudgetPaise: Math.max(0, Math.round(Number(budget) || 0) * 100) }
          : {
              dailyLimitPerUser: Math.max(1, Math.round(Number(dailyLimit) || 1)),
              minPricePaise: Math.max(0, Math.round(Number(minPrice) || 0) * 100),
            };
      const next = await api<AdminTryOnSettings>('/api/admin/tryon/settings', {
        method: 'PUT',
        body,
        auth: true,
      });
      onSaved(next);
      setSaved(true);
      setTimeout(onClose, 700);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const budgetUsed =
    settings.monthlyBudgetPaise > 0
      ? Math.min(100, Math.round((settings.monthSpendPaise / settings.monthlyBudgetPaise) * 100))
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-ink-900">
              {mode === 'MODEL' ? 'Model settings' : 'Usage limits'}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {mode === 'MODEL'
                ? 'Provider status and spend controls for AI Try-On.'
                : 'What each shopper is allowed to run, and which products qualify.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-full px-2 py-1 text-gray-500 hover:bg-gray-100">
            ✕
          </button>
        </div>

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {mode === 'MODEL' ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-xl bg-cream-50 p-3 text-xs text-gray-600">
              <p>
                Active provider:{' '}
                <span className="font-mono font-bold text-ink-900">{settings.provider}</span>
              </p>
              <p className="mt-1">
                Logged cost per successful run:{' '}
                <span className="font-semibold text-ink-900">
                  {formatPaise(settings.costPaisePerRun)}
                </span>
              </p>
              <p className="mt-1">
                This month: {settings.monthRuns.toLocaleString('en-IN')} runs ·{' '}
                {formatPaise(settings.monthSpendPaise)} logged
              </p>
              <p className="mt-1.5 text-[11px] text-gray-400">
                The provider itself is chosen by the API (TRYON_PROVIDER / FASHN_API_KEY).
              </p>
            </div>

            <label className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-3 py-2.5">
              <span className="text-sm">
                <span className="font-semibold text-ink-900">AI Try-On enabled</span>
                <span className="block text-xs text-gray-500">
                  Turning this off stops all new runs storefront-wide.
                </span>
              </span>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-5 w-5 accent-[#B8860B]"
              />
            </label>

            <div>
              <label className="text-xs font-semibold text-gray-500">
                Monthly spend cap (₹) — 0 means unlimited
              </label>
              <input
                type="number"
                min={0}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
              {settings.monthlyBudgetPaise > 0 && (
                <div className="mt-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-cream-100">
                    <div
                      className="h-full rounded-full bg-brand-600"
                      style={{ width: `${budgetUsed}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-gray-500">
                    {budgetUsed}% of this month&apos;s cap used
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Try-ons per shopper per day
              </label>
              <input
                type="number"
                min={1}
                max={500}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Failed runs don&apos;t count against a shopper&apos;s quota.
              </p>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Minimum product price for try-on (₹)
              </label>
              <input
                type="number"
                min={0}
                value={minPrice}
                onChange={(e) => setMinPrice(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Products cheaper than this hide the try-on button.
              </p>
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
          >
            {saved ? '✓ Saved' : busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
