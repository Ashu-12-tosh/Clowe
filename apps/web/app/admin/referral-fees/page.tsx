'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { bpsToPercent, slabDescription, type ReferralFeeSlab } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { toast } from '@/lib/toast';

interface VersionRow {
  version: number;
  source: string;
  effectiveFrom: string;
  note: string | null;
  createdAt: string;
  rates: number;
  inForce: boolean;
}
interface Table {
  version: number;
  effectiveFrom: string;
  source: string;
  groups: { group: string; categories: { sheetCategory: string; slabs: (ReferralFeeSlab & { benchmarkBps: number | null })[] }[] }[];
}
interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  referralPercent: number;
  referralFeeCategory: string | null;
}
interface View {
  versions: VersionRow[];
  table: Table | null;
  categories: CategoryRow[];
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const field = 'rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-600';

/**
 * The referral fee schedule: every version (the one in force marked), its
 * rates by category and price slab, an editor that saves a change as a new
 * version from a chosen time (orders already placed keep their fees), and
 * which schedule category each of our categories is charged under.
 */
export default function AdminReferralFeesPage() {
  const [view, setView] = useState<View | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ sheetCategory: string; slabs: { label: string; ratePercent: string }[]; effectiveFrom: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (v?: number | null) => {
    try {
      setView(await api<View>(`/api/admin/referral-fees${v ? `?version=${v}` : ''}`, { auth: true }));
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : 'Could not load the fee schedule');
    }
  }, []);
  useEffect(() => void load(version), [load, version]);

  const sheetCategories = useMemo(
    () => (view?.table?.groups ?? []).flatMap((g) => g.categories.map((c) => c.sheetCategory)).sort((a, b) => a.localeCompare(b)),
    [view],
  );
  const byId = useMemo(() => new Map((view?.categories ?? []).map((c) => [c.id, c])), [view]);
  const path = (c: CategoryRow): string => (c.parentId && byId.get(c.parentId) ? `${path(byId.get(c.parentId)!)} › ${c.name}` : c.name);
  const inherited = (c: CategoryRow): string | null => {
    let at = c.parentId ? byId.get(c.parentId) : undefined;
    while (at) {
      if (at.referralFeeCategory) return at.referralFeeCategory;
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    return null;
  };

  async function saveEdit() {
    if (!editing || !view?.table) return;
    setBusy(true);
    try {
      const created = await api<{ version: number }>('/api/admin/referral-fees/versions', {
        auth: true,
        body: {
          baseVersion: view.table.version,
          sheetCategory: editing.sheetCategory,
          slabs: editing.slabs.map((s) => ({ label: s.label.trim(), ratePercent: Number(s.ratePercent) })),
          effectiveFrom: editing.effectiveFrom ? new Date(editing.effectiveFrom).toISOString() : undefined,
          note: editing.note,
        },
      });
      toast.success(`Saved as version ${created.version}`);
      setEditing(null);
      setVersion(created.version);
      await load(created.version);
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : 'Could not save the rates');
    } finally {
      setBusy(false);
    }
  }

  async function setMapping(category: CategoryRow, sheetCategory: string | null) {
    try {
      await api(`/api/admin/referral-fees/mapping/${category.id}`, { auth: true, method: 'PUT', body: { sheetCategory } });
      toast.success(`${category.name}: ${sheetCategory ?? 'no schedule category'}`);
      await load(version);
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : 'Could not change the category');
    }
  }

  if (!view) return <p className="p-6 text-sm text-gray-500">Loading…</p>;
  const q = filter.trim().toLowerCase();

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-bold text-ink-900">Referral fee schedule</h1>
        <p className="mt-1 text-sm text-gray-500">
          The rate of the slab a product&apos;s selling price (GST included) falls in applies to the whole price. A change is saved as a new version from the time
          you choose; order lines keep the rate they were placed under. Rates marked “borrowed” fill a gap in the sheet from the family&apos;s “Other products” row.
        </p>
      </div>

      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="font-semibold text-ink-900">Versions</h2>
        {view.versions.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">None yet — import the spreadsheet with prisma/importReferralFees.ts. Until then every category keeps its flat rate.</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100 text-sm" data-fee-versions>
            {view.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <button type="button" onClick={() => setVersion(v.version)} className="font-semibold text-brand-600 hover:underline">
                    Version {v.version}
                  </button>{' '}
                  · {v.source} · {v.rates} rates · from {when(v.effectiveFrom)}
                  {v.note ? <span className="text-gray-500"> · {v.note}</span> : null}
                </span>
                {v.inForce ? (
                  <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-bold text-green-700">In force</span>
                ) : new Date(v.effectiveFrom).getTime() > Date.now() ? (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700">Scheduled</span>
                ) : (
                  <span className="text-xs text-gray-400">Earlier</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.table && (
        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-ink-900">
              Version {view.table.version} rates <span className="font-normal text-gray-500">(from {when(view.table.effectiveFrom)})</span>
            </h2>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a category" className={field} aria-label="Find a category" />
          </div>
          {view.table.groups.map((g) => {
            const cats = g.categories.filter((c) => !q || c.sheetCategory.toLowerCase().includes(q));
            if (cats.length === 0) return null;
            return (
              <div key={g.group} className="mt-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">{g.group}</h3>
                <table className="mt-1 w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {cats.map((c) => (
                      <tr key={c.sheetCategory} className="align-top">
                        <td className="w-1/2 py-2 pr-3 font-medium text-ink-900">{c.sheetCategory}</td>
                        <td className="py-2">
                          {c.slabs.map((s) => (
                            <div key={s.label} className="flex justify-between gap-3 tabular-nums">
                              <span className="text-gray-600">
                                {slabDescription(s)}
                                {s.borrowedFrom && <span className="ml-1 text-[11px] text-amber-700">borrowed: {s.borrowedFrom}</span>}
                              </span>
                              <span>
                                <span className="font-semibold">{bpsToPercent(s.rateBps)}%</span>
                                {s.benchmarkBps !== null && <span className="ml-2 text-[11px] text-gray-400">benchmark {bpsToPercent(s.benchmarkBps)}%</span>}
                              </span>
                            </div>
                          ))}
                        </td>
                        <td className="w-16 py-2 text-right">
                          <button
                            type="button"
                            className="text-xs font-semibold text-brand-600 hover:underline"
                            onClick={() =>
                              setEditing({
                                sheetCategory: c.sheetCategory,
                                slabs: c.slabs.map((s) => ({ label: s.label, ratePercent: String(bpsToPercent(s.rateBps)) })),
                                effectiveFrom: '',
                                note: '',
                              })
                            }
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label="Edit rates">
          <div className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5 shadow-xl">
            <h2 className="font-semibold text-ink-900">{editing.sheetCategory}</h2>
            <p className="text-xs text-gray-500">Slabs as the sheet writes them: “&lt;= 1,000”, “&gt; 1,000”, “&gt; 250 and &lt;= 500” or “All prices”. They must cover every price from ₹0 up.</p>
            {editing.slabs.map((s, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={s.label}
                  onChange={(e) => setEditing({ ...editing, slabs: editing.slabs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                  className={`${field} flex-1`}
                  aria-label="Slab"
                />
                <input
                  value={s.ratePercent}
                  onChange={(e) => setEditing({ ...editing, slabs: editing.slabs.map((x, j) => (j === i ? { ...x, ratePercent: e.target.value } : x)) })}
                  className={`${field} w-24 text-right`}
                  inputMode="decimal"
                  aria-label="Rate %"
                />
                <button type="button" onClick={() => setEditing({ ...editing, slabs: editing.slabs.filter((_, j) => j !== i) })} className="text-xs text-red-600" aria-label="Remove slab">
                  ✕
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setEditing({ ...editing, slabs: [...editing.slabs, { label: '', ratePercent: '' }] })} className="text-xs font-semibold text-brand-600">
              + Add a slab
            </button>
            <label className="block text-xs font-semibold text-gray-600">
              In force from (empty = now)
              <input type="datetime-local" value={editing.effectiveFrom} onChange={(e) => setEditing({ ...editing, effectiveFrom: e.target.value })} className={`${field} mt-1 w-full`} />
            </label>
            <label className="block text-xs font-semibold text-gray-600">
              Why (kept with the version)
              <input value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} className={`${field} mt-1 w-full`} />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={() => void saveEdit()} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Saving…' : 'Save as a new version'}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="font-semibold text-ink-900">Our categories</h2>
        <p className="mt-1 text-xs text-gray-500">Which schedule category each is charged under. Empty = as its parent; with none up the tree, the flat rate.</p>
        <table className="mt-2 w-full text-sm" data-fee-mapping>
          <tbody className="divide-y divide-gray-100">
            {view.categories
              .filter((c) => !q || path(c).toLowerCase().includes(q) || (c.referralFeeCategory ?? '').toLowerCase().includes(q))
              .map((c) => (
                <tr key={c.id}>
                  <td className="py-1.5 pr-3">
                    <span className={c.isActive ? 'text-ink-900' : 'text-gray-400'}>{path(c)}</span>
                  </td>
                  <td className="py-1.5">
                    <select
                      value={c.referralFeeCategory ?? ''}
                      onChange={(e) => void setMapping(c, e.target.value || null)}
                      className={`${field} w-full max-w-md`}
                      aria-label={`Schedule category for ${c.name}`}
                    >
                      <option value="">{inherited(c) ? `As parent: ${inherited(c)}` : `Flat ${c.referralPercent}%`}</option>
                      {sheetCategories.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
