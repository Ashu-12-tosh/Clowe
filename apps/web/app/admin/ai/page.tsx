'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AiSettings, AiUsageView } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const rupees = (paise: number) => (paise < 100 ? `₹${(paise / 100).toFixed(4)}` : formatPaise(Math.round(paise)));

/**
 * AI (Gemini): what it costs this month against the budget, by feature and by
 * day, the latest calls, and the settings — budget, per-user daily limits, and
 * the model's prices used to work out the cost.
 */
export default function AdminAiPage() {
  const [month, setMonth] = useState(() => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7));
  const [view, setView] = useState<AiUsageView | null>(null);
  const [draft, setDraft] = useState<Record<keyof AiSettings, string> | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<AiUsageView>(`/api/admin/ai?month=${month}`, { auth: true })
      .then((v) => {
        setView(v);
        const s = v.settings;
        setDraft({
          monthlyBudgetPaise: String(s.monthlyBudgetPaise / 100),
          usdInrRate: String(s.usdInrRate),
          inputUsdPerMillion: String(s.inputUsdPerMillion),
          outputUsdPerMillion: String(s.outputUsdPerMillion),
          shopperDailyCalls: String(s.shopperDailyCalls),
          sellerDailyCalls: String(s.sellerDailyCalls),
        });
      })
      .catch((e) => setError(e instanceof ApiRequestError ? e.message : 'Could not load'));
  }, [month]);
  useEffect(load, [load]);

  async function save() {
    if (!draft) return;
    setError('');
    try {
      await api('/api/admin/ai', {
        method: 'PATCH',
        auth: true,
        success: 'AI settings saved',
        body: {
          monthlyBudgetPaise: Math.round(Number(draft.monthlyBudgetPaise) * 100),
          usdInrRate: Number(draft.usdInrRate),
          inputUsdPerMillion: Number(draft.inputUsdPerMillion),
          outputUsdPerMillion: Number(draft.outputUsdPerMillion),
          shopperDailyCalls: Math.round(Number(draft.shopperDailyCalls)),
          sellerDailyCalls: Math.round(Number(draft.sellerDailyCalls)),
        },
      });
      load();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Not saved');
    }
  }

  const pct = view ? Math.min(100, Math.round((view.spentPaise / Math.max(1, view.settings.monthlyBudgetPaise)) * 100)) : 0;
  const field = (key: keyof AiSettings, label: string, hint: string) => (
    <label className="block text-sm">
      <span className="font-medium text-ink-900">{label}</span>
      <input value={draft?.[key] ?? ''} name={key} onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" inputMode="decimal" />
      <span className="text-[11px] text-gray-500">{hint}</span>
    </label>
  );

  return (
    <div className="space-y-4" data-admin-ai>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">AI usage</h1>
          <p className="text-sm text-gray-500">
            {view ? `${view.provider} · ${view.model}` : '…'} — AI search, the assistant, recommendations, compare summaries, listing and marketing drafts.
          </p>
        </div>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded border border-gray-200 px-2 py-1 text-sm" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {view && (
        <>
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="text-sm text-gray-600">
              Spent <strong className="text-ink-900">{rupees(view.spentPaise)}</strong> of {formatPaise(view.settings.monthlyBudgetPaise)} · {view.calls} calls ({view.failed} failed) ·{' '}
              {view.inputTokens.toLocaleString('en-IN')} in / {view.outputTokens.toLocaleString('en-IN')} out tokens
            </p>
            <div className="mt-2 h-2 rounded-full bg-gray-100">
              <div className={`h-2 rounded-full ${pct >= 100 ? 'bg-red-500' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-gray-500">At the budget, AI pauses until the month ends: search falls back to the normal search, and nothing shows an error page.</p>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="text-sm font-bold">By feature</h2>
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {view.byTask.map((t) => (
                    <tr key={t.task} className="border-t border-gray-100">
                      <td className="py-1">{t.task}</td>
                      <td className="text-right">{t.calls}</td>
                      <td className="text-right">{rupees(t.costPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="text-sm font-bold">By day</h2>
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {view.byDay.map((d) => (
                    <tr key={d.day} className="border-t border-gray-100">
                      <td className="py-1">{d.day}</td>
                      <td className="text-right">{d.calls}</td>
                      <td className="text-right">{rupees(d.costPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold">Settings</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {field('monthlyBudgetPaise', 'Monthly budget (₹)', 'All AI calls together, per calendar month')}
              {field('shopperDailyCalls', 'Calls a day per shopper', 'Signed-out visitors count by address')}
              {field('sellerDailyCalls', 'Calls a day per seller', 'Listing, marketing and the seller assistant')}
              {field('inputUsdPerMillion', 'Input price ($ per 1M tokens)', 'From Google’s price list for the model')}
              {field('outputUsdPerMillion', 'Output price ($ per 1M tokens)', 'Thinking tokens count as output')}
              {field('usdInrRate', 'USD → INR', 'For the costs shown here')}
            </div>
            <button type="button" onClick={() => void save()} className="mt-3 rounded-lg bg-ink-900 px-4 py-2 text-sm font-semibold text-white">
              Save
            </button>
          </section>
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold">Latest calls</h2>
            <table className="mt-2 w-full text-xs">
              <tbody>
                {view.recent.map((r, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="py-1">{new Date(r.at).toLocaleString('en-IN')}</td>
                    <td>{r.task}</td>
                    <td className="text-right">{r.inputTokens}/{r.outputTokens}</td>
                    <td className="text-right">{rupees(r.costPaise)}</td>
                    <td className="text-right">{r.ok ? '✓' : '✕'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
