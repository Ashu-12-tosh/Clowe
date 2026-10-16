'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CPC_AD_TYPE_LABELS,
  CPC_AD_TYPES,
  PLACEMENT_KINDS,
  PLACEMENT_LABELS,
  PLAN_FEATURE_LABELS,
  PLAN_FEATURES,
  type CommercialSettings,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { toast } from '@/lib/toast';

type Json = unknown;
type Path = (string | number)[];

const SECTIONS: { key: keyof CommercialSettings; title: string; note: string }[] = [
  { key: 'fees', title: 'Seller fees per order line', note: 'Percents are of the selling price (GST included). Each category has its own referral fee (Admin → Categories); this is the default. New orders only.' },
  { key: 'penalties', title: 'Admin penalties', note: 'Applied by an admin from a seller’s page, with a reason; deducted from payout.' },
  { key: 'plans', title: 'Seller plans', note: 'Monthly, auto-renewing, paid from the Seller Wallet first and then the next payout.' },
  { key: 'ads', title: 'Advertising', note: 'CPC ranges, fixed packages, and premium placements (price inside the range).' },
  { key: 'sponsorship', title: 'Sponsorship', note: 'Sponsorship placements and their prices are in the placements table above (marked "sponsorship").' },
  { key: 'tryon', title: 'AI Try-On credits', note: 'Cost per credit, tiers and the phase note are admin only — vendors never see them.' },
];

const human = (key: string) =>
  key
    .replace(/Paise$/, ' (₹)')
    .replace(/Percent$/, ' (%)')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

/** Money is stored in paise and edited in rupees. */
const isMoney = (path: Path) => path.some((p) => typeof p === 'string' && /Paise$/.test(p));

function setAt(obj: Json, path: Path, value: Json): Json {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy = (Array.isArray(obj) ? [...obj] : { ...(obj as Record<string, Json>) }) as Record<string | number, Json>;
  copy[head as string] = setAt((obj as Record<string | number, Json>)[head as string], rest, value);
  return copy;
}

/** A checkbox group for the lists that name plan features, ad types or placements. */
function choicesFor(path: Path): { values: readonly string[]; labels: Record<string, string> } | null {
  const last = path[path.length - 1];
  if (last === 'features') return { values: PLAN_FEATURES, labels: PLAN_FEATURE_LABELS };
  if (last === 'types' || last === 'unavailableTypes') return { values: CPC_AD_TYPES, labels: CPC_AD_TYPE_LABELS };
  if (last === 'placements' && path.includes('packages')) return { values: PLACEMENT_KINDS, labels: PLACEMENT_LABELS };
  return null;
}

function Field({ path, value, onChange }: { path: Path; value: Json; onChange: (path: Path, value: Json) => void }) {
  const name = path.join('.');
  const label = String(path[path.length - 1]);
  const labelText = (CPC_AD_TYPE_LABELS as Record<string, string>)[label] ?? (PLACEMENT_LABELS as Record<string, string>)[label] ?? human(label);
  const choices = choicesFor(path);

  if (choices && Array.isArray(value)) {
    const list = value as string[];
    return (
      <fieldset className="col-span-full">
        <legend className="text-xs font-semibold text-gray-700">{human(label)}</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {choices.values.map((v) => (
            <label key={v} className="flex items-center gap-1.5 text-xs text-gray-700">
              <input
                type="checkbox"
                name={`${name}.${v}`}
                checked={list.includes(v)}
                onChange={(e) => onChange(path, e.target.checked ? [...list, v] : list.filter((x) => x !== v))}
              />
              {choices.labels[v] ?? v}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  // A [min, max] range.
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number') && /range/i.test(name + label)) {
    const money = /Paise|cpcRanges|rangePaise/.test(name);
    const [lo, hi] = value as number[];
    return (
      <div>
        <label className="text-xs font-semibold text-gray-700">{labelText} {money ? '(₹ min – max)' : '(min – max)'}</label>
        <div className="mt-1 flex gap-2">
          {[lo, hi].map((v, i) => (
            <input
              key={i}
              type="number"
              step="0.01"
              name={`${name}.${i}`}
              value={money ? v! / 100 : v}
              onChange={(e) => {
                const next = [lo, hi];
                next[i] = money ? Math.round(Number(e.target.value) * 100) : Number(e.target.value);
                onChange(path, next);
              }}
              className="w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
            />
          ))}
        </div>
      </div>
    );
  }
  if (Array.isArray(value)) {
    const rows = value as Json[];
    const blank = rows[0] && typeof rows[0] === 'object' ? Object.fromEntries(Object.keys(rows[0] as object).map((k) => [k, 0])) : 0;
    return (
      <div className="col-span-full rounded-lg border border-gray-200 p-3">
        <p className="text-xs font-semibold text-gray-700">{human(label)}</p>
        <div className="mt-2 space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              {row && typeof row === 'object' ? (
                Object.entries(row as Record<string, Json>).map(([k, v]) => (
                  <div key={k} className="min-w-28 flex-1">
                    <Field path={[...path, i, k]} value={v} onChange={onChange} />
                  </div>
                ))
              ) : (
                <div className="min-w-28 flex-1">
                  <Field path={[...path, i]} value={row} onChange={onChange} />
                </div>
              )}
              <button type="button" onClick={() => onChange(path, rows.filter((_, j) => j !== i))} className="pb-1 text-xs text-red-600">
                Remove
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => onChange(path, [...rows, blank])} className="mt-2 text-xs font-semibold text-brand-600">
          + Add a row
        </button>
      </div>
    );
  }
  if (value && typeof value === 'object') {
    return (
      <div className="col-span-full rounded-lg border border-gray-100 bg-cream-50/50 p-3">
        <p className="text-xs font-bold text-ink-900">{labelText}</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(value as Record<string, Json>).map(([k, v]) => (
            <Field key={k} path={[...path, k]} value={v} onChange={onChange} />
          ))}
        </div>
      </div>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-xs font-semibold text-gray-700">
        <input type="checkbox" name={name} checked={value} onChange={(e) => onChange(path, e.target.checked)} />
        {labelText}
      </label>
    );
  }
  if (typeof value === 'number' || value === null) {
    const money = isMoney(path);
    return (
      <div>
        <label className="text-xs font-semibold text-gray-700">{labelText}</label>
        <input
          type="number"
          step="0.01"
          name={name}
          value={value === null ? '' : money ? value / 100 : value}
          placeholder={value === null ? 'none' : undefined}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(path, raw === '' && /max|expiry/i.test(label) ? null : money ? Math.round(Number(raw) * 100) : Number(raw));
          }}
          className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
        />
      </div>
    );
  }
  return (
    <div className="col-span-full">
      <label className="text-xs font-semibold text-gray-700">{labelText}</label>
      <input
        name={name}
        value={String(value ?? '')}
        onChange={(e) => onChange(path, e.target.value)}
        className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
      />
    </div>
  );
}

/**
 * The owner's commercial rules (Batch 2), every number in one place: fees,
 * penalties, plans, advertising, sponsorship and try-on credits. A section
 * saves on its own; a fee change for sellers can be scheduled with 30 days'
 * notice instead (Vendor Terms 6.2).
 */
export default function AdminCommercialPage() {
  const [rules, setRules] = useState<CommercialSettings | null>(null);
  const [draft, setDraft] = useState<CommercialSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [effectiveOn, setEffectiveOn] = useState('');

  const load = useCallback(() => {
    api<CommercialSettings>('/api/admin/commercial', { auth: true })
      .then((r) => {
        setRules(r);
        setDraft(r);
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Could not load the rules'));
  }, []);
  useEffect(load, [load]);

  async function save(section: keyof CommercialSettings) {
    if (!draft) return;
    setBusy(section);
    setError('');
    try {
      const next = await api<CommercialSettings>('/api/admin/commercial', {
        method: 'PATCH',
        auth: true,
        body: { [section]: draft[section] },
        success: 'Saved',
        quiet: true,
      });
      setRules(next);
      setDraft(next);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Not saved');
    } finally {
      setBusy(null);
    }
  }

  async function schedule(section: keyof CommercialSettings) {
    if (!draft || !effectiveOn) {
      toast.error('Pick the date the change takes effect (at least 30 days ahead)');
      return;
    }
    setBusy(`schedule:${section}`);
    setError('');
    try {
      await api('/api/admin/fee-changes', {
        auth: true,
        body: { patch: { [section]: draft[section] }, effectiveAt: new Date(`${effectiveOn}T00:00:00+05:30`).toISOString() },
        success: 'Scheduled — sellers are being told',
        quiet: true,
      });
      setDraft(rules);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Not scheduled');
    } finally {
      setBusy(null);
    }
  }

  if (!draft) return <p className="text-sm text-gray-500">{error || 'Loading…'}</p>;
  const minDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Commercial rules</h1>
        <p className="mt-1 text-sm text-gray-500">
          What sellers pay Clowe. Every Clowe charge is exclusive of GST; GST is added and shown on the seller&apos;s monthly tax invoice.
        </p>
      </div>
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        Fee changes for sellers need 30 days&apos; notice. To schedule one, edit a section, pick the date and press &ldquo;Schedule&rdquo;:
        <input type="date" name="effectiveOn" min={minDate} value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} className="rounded border border-amber-300 px-2 py-1" />
      </div>
      {SECTIONS.map((s) => (
        <section key={s.key} className="rounded-2xl border border-gray-100 bg-white p-4" data-commercial-section={s.key}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-ink-900">{s.title}</h2>
              <p className="text-xs text-gray-500">{s.note}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => void save(s.key)} disabled={!!busy} className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                {busy === s.key ? 'Saving…' : 'Save now'}
              </button>
              {(s.key === 'fees' || s.key === 'plans' || s.key === 'penalties') && (
                <button onClick={() => void schedule(s.key)} disabled={!!busy} className="rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-bold text-amber-900 disabled:opacity-50">
                  Schedule
                </button>
              )}
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(draft[s.key] as Record<string, Json>).map(([k, v]) => (
              <Field key={k} path={[s.key, k]} value={v} onChange={(path, value) => setDraft((d) => setAt(d, path, value) as CommercialSettings)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
