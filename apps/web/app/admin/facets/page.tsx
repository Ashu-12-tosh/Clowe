'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  COMMON_FACET_LABELS,
  COMMON_FACETS,
  FACET_KEY_RE,
  FACET_KINDS,
  FACET_KIND_LABELS,
  RESERVED_FACET_KEYS,
  resolveFacets,
  type AdminCategoryFacets,
  type AdminCategoryRow,
  type CategoryFacetConfig,
  type FacetDef,
  type FacetKind,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const EMPTY: CategoryFacetConfig = { add: [], hide: [] };

/** A row of the preview: what shoppers would see here once the draft is saved. */
interface PreviewRow extends FacetDef {
  kind: FacetKind;
  own: boolean;
  fromName: string;
  productsWithValue: number | null;
}

/** The draft applied to what the parent passes down — the same rules the API resolves by. */
function preview(view: AdminCategoryFacets, draft: CategoryFacetConfig | null): PreviewRow[] {
  const inherited = view.inherited;
  const resolved = resolveFacets([
    { id: '__parent', config: { add: inherited.map(({ key, label, kind, values, alsoKeys }) => ({ key, label, kind, values, alsoKeys })), hide: [] } },
    { id: '__self', config: draft },
  ]);
  const coverage = new Map([...view.inherited, ...view.resolved].map((r) => [r.key, r.productsWithValue]));
  return resolved.map((f) => ({
    ...f,
    own: f.fromCategoryId === '__self',
    fromName: f.fromCategoryId === '__self' ? view.category.name : (inherited.find((i) => i.key === f.key)?.fromCategoryName ?? ''),
    productsWithValue: coverage.get(f.key) ?? null,
  }));
}

/** One value per line: a value may itself hold a comma. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

function FacetForm({
  initial,
  takenKeys,
  onSave,
  onCancel,
}: {
  initial: FacetDef | null;
  takenKeys: string[];
  onSave: (def: FacetDef) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState(initial?.key ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [kind, setKind] = useState<FacetKind>(initial?.kind ?? 'list');
  const [values, setValues] = useState((initial?.values ?? []).join('\n'));
  const [alsoKeys, setAlsoKeys] = useState((initial?.alsoKeys ?? []).join(', '));
  const [error, setError] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const k = key.trim();
    if (!FACET_KEY_RE.test(k)) return setError('Key: lowercase letters, digits and _, starting with a letter.');
    if (RESERVED_FACET_KEYS.includes(k)) return setError(`"${k}" is on every rail already.`);
    if (!initial && takenKeys.includes(k)) return setError(`"${k}" is already a facet here — edit that one.`);
    if (!label.trim()) return setError('Give it a label shoppers will read.');
    const also = alsoKeys.split(',').map((a) => a.trim()).filter(Boolean);
    if (also.some((a) => !FACET_KEY_RE.test(a))) return setError('Other keys: same alphabet as the key.');
    const vals = lines(values);
    onSave({ key: k, label: label.trim(), kind, ...(vals.length ? { values: vals } : {}), ...(also.length ? { alsoKeys: also } : {}) });
  }

  const field = 'mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-600';
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4" data-facet-form>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-semibold text-gray-700">
          Key
          <input value={key} onChange={(e) => setKey(e.target.value)} disabled={!!initial} placeholder="screen_size" className={field} />
        </label>
        <label className="text-xs font-semibold text-gray-700">
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Screen size" className={field} />
        </label>
        <label className="text-xs font-semibold text-gray-700">
          Shown as
          <select value={kind} onChange={(e) => setKind(e.target.value as FacetKind)} className={field}>
            {FACET_KINDS.map((k) => (
              <option key={k} value={k}>
                {FACET_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs font-semibold text-gray-700">
        Known values, in the order shoppers read them (one per line) — sellers pick from these
        <textarea value={values} onChange={(e) => setValues(e.target.value)} rows={4} placeholder={'Leave empty for open-ended values (author, fabric)'} className={field} />
      </label>
      <label className="block text-xs font-semibold text-gray-700">
        Other keys holding the same thing (comma separated)
        <input value={alsoKeys} onChange={(e) => setAlsoKeys(e.target.value)} placeholder="size, screen" className={field} />
      </label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-bold text-white">
          {initial ? 'Apply' : 'Add facet'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold">
          Cancel
        </button>
      </div>
    </form>
  );
}

function Editor({ categoryId }: { categoryId: string }) {
  const [view, setView] = useState<AdminCategoryFacets | null>(null);
  const [draft, setDraft] = useState<CategoryFacetConfig | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setView(null);
    api<AdminCategoryFacets>(`/api/admin/category-facets/${categoryId}`, { auth: true })
      .then((v) => {
        setView(v);
        setDraft(v.own);
      })
      .catch(() => setError('Could not load this category.'));
  }, [categoryId]);
  useEffect(() => {
    setEditing(null);
    setError('');
    setNotice('');
    load();
  }, [load]);

  const rows = useMemo(() => (view ? preview(view, draft) : []), [view, draft]);
  const dirty = view ? JSON.stringify(view.own) !== JSON.stringify(draft) : false;
  const hidden = view ? view.inherited.filter((i) => draft?.hide.includes(i.key)) : [];

  const edit = (fn: (c: CategoryFacetConfig) => CategoryFacetConfig) => setDraft((d) => fn(d ?? EMPTY));
  const putDef = (def: FacetDef) =>
    edit((c) => {
      const at = c.add.findIndex((a) => a.key === def.key);
      const add = at === -1 ? [...c.add, def] : c.add.map((a, i) => (i === at ? def : a));
      return { ...c, add, hide: c.hide.filter((h) => h !== def.key) };
    });
  const removeOwn = (key: string) => edit((c) => ({ ...c, add: c.add.filter((a) => a.key !== key) }));
  const hide = (key: string) => edit((c) => ({ ...c, hide: [...c.hide, key] }));
  const unhide = (key: string) => edit((c) => ({ ...c, hide: c.hide.filter((h) => h !== key) }));
  const move = (index: number, by: -1 | 1) =>
    edit((c) => {
      const keys = rows.map((r) => r.key);
      const to = index + by;
      if (to < 0 || to >= keys.length) return c;
      [keys[index], keys[to]] = [keys[to], keys[index]];
      return { ...c, order: keys };
    });

  async function save(config: CategoryFacetConfig | null) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const v = await api<AdminCategoryFacets>(`/api/admin/category-facets/${categoryId}`, {
        method: 'PUT',
        auth: true,
        body: { config },
      });
      setView(v);
      setDraft(v.own);
      setNotice(config ? 'Saved. Listings in this category and below use it now.' : "Reset: this category now shows its parent's set.");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !view) return <p className="text-sm text-red-600">{error}</p>;
  if (!view) return <p className="text-sm text-gray-400">Loading…</p>;

  return (
    <div data-facet-editor>
      <p className="text-xs text-gray-500">{view.category.path.map((p) => p.name).join(' › ')}</p>
      <h2 className="font-display text-xl font-bold text-ink-900">{view.category.name}</h2>
      <p className="mt-1 text-xs text-gray-500">
        {view.liveProducts} live products here and below.{' '}
        {draft === null ? "No facets of its own: it shows exactly its parent's set." : 'Has its own facet edits.'} Every rail also has{' '}
        {COMMON_FACETS.map((c) => COMMON_FACET_LABELS[c]).join(', ')}.
      </p>

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Facet</th>
              <th className="hidden px-3 py-2 md:table-cell">From</th>
              <th className="px-3 py-2 text-right">Products</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} className="border-t border-gray-100 align-top" data-facet-row={r.key}>
                <td className="px-3 py-2">
                  <p className="font-semibold text-ink-900">
                    {r.label} <span className="font-mono text-[11px] font-normal text-gray-400">{r.key}</span>
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {FACET_KIND_LABELS[r.kind]}
                    {r.values?.length ? ` · ${r.values.length} values: ${r.values.slice(0, 4).join(', ')}${r.values.length > 4 ? '…' : ''}` : ' · open values'}
                    {r.alsoKeys?.length ? ` · also reads ${r.alsoKeys.join(', ')}` : ''}
                  </p>
                  {editing === r.key && (
                    <div className="mt-2">
                      <FacetForm
                        initial={r}
                        takenKeys={rows.map((x) => x.key)}
                        onSave={(def) => {
                          putDef(def);
                          setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    </div>
                  )}
                </td>
                <td className="hidden px-3 py-2 text-xs md:table-cell">
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${r.own ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-600'}`}>
                    {r.own ? 'This category' : `Inherited · ${r.fromName}`}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-gray-600">
                  {r.productsWithValue === null ? '—' : `${r.productsWithValue}/${view.liveProducts}`}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                  <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${r.label} up`} className="px-1 disabled:opacity-30">
                    ↑
                  </button>
                  <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move ${r.label} down`} className="px-1 disabled:opacity-30">
                    ↓
                  </button>
                  <button onClick={() => setEditing(r.key)} className="ml-2 font-semibold text-brand-600 hover:underline">
                    {r.own ? 'Edit' : 'Override'}
                  </button>
                  {r.own ? (
                    <button onClick={() => removeOwn(r.key)} className="ml-2 font-semibold text-red-600 hover:underline">
                      Remove
                    </button>
                  ) : (
                    <button onClick={() => hide(r.key)} className="ml-2 font-semibold text-gray-600 hover:underline">
                      Hide here
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-xs text-gray-400">
                  No category facets: shoppers see the common ones, and any option axes the variants carry.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hidden.length > 0 && (
        <p className="mt-3 text-xs text-gray-600">
          Hidden here:{' '}
          {hidden.map((h) => (
            <button key={h.key} onClick={() => unhide(h.key)} className="mr-2 rounded-full border border-gray-300 px-2 py-0.5 hover:border-brand-600">
              {h.label} ↺
            </button>
          ))}
        </p>
      )}

      <div className="mt-4">
        {editing === 'new' ? (
          <FacetForm
            initial={null}
            takenKeys={rows.map((r) => r.key)}
            onSave={(def) => {
              putDef(def);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button onClick={() => setEditing('new')} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:border-brand-600">
            ＋ Add facet
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-3 text-sm text-green-700">✓ {notice}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => save(draft)}
          disabled={!dirty || busy}
          className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setDraft(view.own)} disabled={!dirty || busy} className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold disabled:opacity-40">
          Discard changes
        </button>
        {view.own !== null && (
          <button onClick={() => save(null)} disabled={busy} className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold text-gray-700">
            Reset to the parent&apos;s set
          </button>
        )}
      </div>

      {view.children.length > 0 && (
        <div className="mt-8" data-facet-children>
          <h3 className="text-sm font-bold text-ink-900">What the subcategories end up with</h3>
          <p className="text-xs text-gray-500">Saved state. A subcategory with its own edits applies them on top of this one&apos;s.</p>
          <ul className="mt-2 space-y-1.5 text-xs">
            {view.children.map((c) => (
              <li key={c.id} className="rounded-lg border border-gray-100 bg-white px-3 py-2">
                <span className="font-semibold text-ink-900">{c.name}</span>
                {c.hasOwn && <span className="ml-2 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">own edits</span>}
                <span className="ml-2 text-gray-500">{c.facets.map((f) => f.label).join(' · ') || 'common facets only'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FacetsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<AdminCategoryRow[] | null>(null);
  const selected = searchParams.get('category');

  useEffect(() => {
    api<AdminCategoryRow[]>('/api/admin/categories', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  const ordered = useMemo(() => {
    const out: AdminCategoryRow[] = [];
    const visit = (parentId: string | null) => {
      for (const r of (rows ?? []).filter((x) => x.parentId === parentId)) {
        out.push(r);
        visit(r.id);
      }
    };
    visit(null);
    return out;
  }, [rows]);

  return (
    <div>
      <h1 className="font-display text-2xl font-bold text-ink-900">Filter facets</h1>
      <p className="mt-0.5 text-sm text-gray-500">
        What shoppers can narrow a listing by, per category. A category inherits its parent&apos;s facets; edit them here to add, hide,
        override or reorder.
      </p>
      <div className="mt-5 grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav className="max-h-[70vh] overflow-y-auto rounded-xl border border-gray-200 bg-white p-2" aria-label="Categories">
          {rows === null && <p className="p-2 text-xs text-gray-400">Loading…</p>}
          {ordered.map((r) => (
            <button
              key={r.id}
              onClick={() => router.push(`/admin/facets?category=${r.id}`)}
              className={`block w-full truncate rounded-md px-2 py-1 text-left text-sm ${
                selected === r.id ? 'bg-brand-100 font-semibold text-brand-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
              style={{ paddingLeft: `${0.5 + r.depth * 1}rem` }}
            >
              {r.name}
            </button>
          ))}
        </nav>
        <section className="min-w-0">
          {selected ? <Editor key={selected} categoryId={selected} /> : <p className="text-sm text-gray-500">Pick a category.</p>}
        </section>
      </div>
    </div>
  );
}

export default function AdminFacetsPage() {
  return (
    <Suspense>
      <FacetsPageInner />
    </Suspense>
  );
}
