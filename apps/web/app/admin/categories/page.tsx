'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TAX_RATES,
  axisLabel,
  describeTaxDefault,
  type AdminCategoryRow,
  type AttributeDef,
  type CategoryRulesInput,
  type VariantAxis,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const field =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

/** "Screen size" → "screen_size". */
function keyFrom(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 24);
}

/** Axes as one editable line: "Colour, Storage, RAM" (keys derived from the labels). */
function axesToText(axes: VariantAxis[] | null): string {
  return (axes ?? []).map((a) => a.label).join(', ');
}
function axesFromText(text: string): VariantAxis[] {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((label) => ({ key: keyFrom(label), label }))
    .filter((a) => a.key && !seen.has(a.key) && seen.add(a.key))
    .slice(0, 3)
    .map((a) => ({ ...a, label: axisLabel(a.key) === a.label ? a.label : a.label }));
}

interface AttrDraft {
  label: string;
  type: AttributeDef['type'];
  required: boolean;
  options: string;
  unit: string;
}

const emptyAttr: AttrDraft = { label: '', type: 'text', required: false, options: '', unit: '' };

function attrsToDraft(schema: AttributeDef[] | null): AttrDraft[] {
  return (schema ?? []).map((d) => ({
    label: d.label,
    type: d.type,
    required: !!d.required,
    options: (d.options ?? []).join(', '),
    unit: d.unit ?? '',
  }));
}
function attrsFromDraft(drafts: AttrDraft[]): AttributeDef[] {
  return drafts
    .filter((d) => d.label.trim())
    .map((d) => ({
      key: keyFrom(d.label),
      label: d.label.trim(),
      type: d.type,
      required: d.required || undefined,
      unit: d.unit.trim() || undefined,
      options:
        d.type === 'select'
          ? d.options
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
    }))
    .filter((d) => d.key);
}

/** Editor for one category's marketplace rules (blank = inherit from the parent). */
function RulesEditor({
  row,
  onSaved,
  onClose,
}: {
  row: AdminCategoryRow;
  onSaved: () => void;
  onClose: () => void;
}) {
  const own = row.own;
  const [axesText, setAxesText] = useState(axesToText(own.variantAxes));
  const [attrs, setAttrs] = useState<AttrDraft[]>(attrsToDraft(own.attributeSchema));
  const [tryOn, setTryOn] = useState(own.tryOnEligible === null ? '' : String(own.tryOnEligible));
  const [sizeGuide, setSizeGuide] = useState(own.sizeGuide === null ? '' : String(own.sizeGuide));
  const [tax, setTax] = useState(
    own.taxRule === 'APPAREL_SLAB'
      ? 'APPAREL_SLAB'
      : own.defaultTaxRatePercent !== null
        ? String(own.defaultTaxRatePercent)
        : '',
  );
  const [hsn, setHsn] = useState(own.hsnCode ?? '');
  const [returnDays, setReturnDays] = useState(
    own.returnWindowDays === null ? '' : String(own.returnWindowDays),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const inherited = row.rules;
  const bool = (v: string): boolean | null => (v === '' ? null : v === 'true');

  async function save() {
    setBusy(true);
    setError('');
    const body: CategoryRulesInput = {
      variantAxes: axesText.trim() ? axesFromText(axesText) : null,
      attributeSchema: attrs.some((a) => a.label.trim()) ? attrsFromDraft(attrs) : null,
      tryOnEligible: bool(tryOn),
      sizeGuide: bool(sizeGuide),
      taxRule: tax === 'APPAREL_SLAB' ? 'APPAREL_SLAB' : null,
      defaultTaxRatePercent: tax !== '' && tax !== 'APPAREL_SLAB' ? Number(tax) : null,
      hsnCode: hsn.trim() || null,
      returnWindowDays: returnDays.trim() === '' ? null : Number(returnDays),
    };
    try {
      await api(`/api/admin/categories/${row.id}`, { method: 'PATCH', body, auth: true });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save rules');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-brand-100 bg-cream-50 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold text-ink-900">Rules for {row.name}</p>
          <p className="text-xs text-gray-500">
            Leave a field blank to inherit from the parent (
            {row.depth === 0 ? 'platform default' : 'shown in grey'}).
          </p>
        </div>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-ink-900">
          ✕ Close
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="text-xs font-semibold text-gray-700">
            Variant options sellers get by default (comma separated, max 3)
          </label>
          <input
            value={axesText}
            onChange={(e) => setAxesText(e.target.value)}
            placeholder={
              inherited.variantAxes.length
                ? `Inherited: ${inherited.variantAxes.map((a) => a.label).join(', ')}`
                : 'e.g. Colour, Storage, RAM'
            }
            className={`mt-1 w-full ${field}`}
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-gray-700">AI Try-On</label>
          <select value={tryOn} onChange={(e) => setTryOn(e.target.value)} className={`mt-1 w-full ${field}`}>
            <option value="">Inherit ({inherited.tryOnEligible ? 'yes' : 'no'})</option>
            <option value="true">Yes — wearable category</option>
            <option value="false">No</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-700">Size guide</label>
          <select
            value={sizeGuide}
            onChange={(e) => setSizeGuide(e.target.value)}
            className={`mt-1 w-full ${field}`}
          >
            <option value="">Inherit ({inherited.sizeGuide ? 'yes' : 'no'})</option>
            <option value="true">Show</option>
            <option value="false">Hide</option>
          </select>
        </div>

        <div>
          <label className="text-xs font-semibold text-gray-700">GST default</label>
          <select value={tax} onChange={(e) => setTax(e.target.value)} className={`mt-1 w-full ${field}`}>
            <option value="">Inherit ({describeTaxDefault(inherited)})</option>
            <option value="APPAREL_SLAB">Apparel slab (5% up to ₹1,000, 12% above)</option>
            {TAX_RATES.map((r) => (
              <option key={r} value={r}>
                {r}%
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-700">HSN code</label>
          <input
            value={hsn}
            onChange={(e) => setHsn(e.target.value)}
            placeholder={inherited.hsnCode ? `Inherited: ${inherited.hsnCode}` : 'e.g. 8471'}
            maxLength={12}
            className={`mt-1 w-full ${field}`}
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-700">Return window (days)</label>
          <input
            type="number"
            min={0}
            max={90}
            value={returnDays}
            onChange={(e) => setReturnDays(e.target.value)}
            placeholder={
              inherited.returnWindowDays !== null
                ? `Inherited: ${inherited.returnWindowDays}`
                : 'Platform default'
            }
            className={`mt-1 w-full ${field}`}
          />
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-gray-700">
            Spec sheet sellers fill in{' '}
            {inherited.attributeSchema.length > 0 && !attrs.some((a) => a.label.trim()) && (
              <span className="font-normal text-gray-400">
                (inheriting {inherited.attributeSchema.length} fields:{' '}
                {inherited.attributeSchema.map((d) => d.label).join(', ')})
              </span>
            )}
          </label>
          <div className="flex gap-2">
            {inherited.attributeSchema.length > 0 && !attrs.some((a) => a.label.trim()) && (
              <button
                type="button"
                onClick={() => setAttrs(attrsToDraft(inherited.attributeSchema))}
                className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-gray-50"
              >
                Copy inherited to edit
              </button>
            )}
            <button
              type="button"
              onClick={() => setAttrs((prev) => [...prev, { ...emptyAttr }])}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-gray-50"
            >
              ＋ Field
            </button>
          </div>
        </div>
        <div className="mt-2 space-y-2">
          {attrs.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                value={a.label}
                onChange={(e) => setAttrs((p) => p.map((x, j) => (i === j ? { ...x, label: e.target.value } : x)))}
                placeholder="Label, e.g. Warranty"
                className={`${field} w-44`}
              />
              <select
                value={a.type}
                onChange={(e) =>
                  setAttrs((p) =>
                    p.map((x, j) => (i === j ? { ...x, type: e.target.value as AttributeDef['type'] } : x)),
                  )
                }
                className={`${field} bg-white`}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="select">Choice</option>
              </select>
              {a.type === 'select' && (
                <input
                  value={a.options}
                  onChange={(e) => setAttrs((p) => p.map((x, j) => (i === j ? { ...x, options: e.target.value } : x)))}
                  placeholder="Choices, comma separated"
                  className={`${field} w-56`}
                />
              )}
              {a.type === 'number' && (
                <input
                  value={a.unit}
                  onChange={(e) => setAttrs((p) => p.map((x, j) => (i === j ? { ...x, unit: e.target.value } : x)))}
                  placeholder="Unit"
                  className={`${field} w-20`}
                />
              )}
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={a.required}
                  onChange={(e) => setAttrs((p) => p.map((x, j) => (i === j ? { ...x, required: e.target.checked } : x)))}
                  className="h-3.5 w-3.5 accent-[#B8860B]"
                />
                Required
              </label>
              <button
                type="button"
                onClick={() => setAttrs((p) => p.filter((_, j) => j !== i))}
                className="text-red-500"
                aria-label="Remove field"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-xs font-semibold hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={() => void save()}
          className="rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save rules'}
        </button>
      </div>
    </div>
  );
}

export default function AdminCategoriesPage() {
  const [rows, setRows] = useState<AdminCategoryRow[] | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [parentId, setParentId] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<AdminCategoryRow[]>('/api/admin/categories', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  const byParent = useMemo(() => {
    const map = new Map<string | null, AdminCategoryRow[]>();
    for (const r of rows ?? []) {
      const list = map.get(r.parentId) ?? [];
      list.push(r);
      map.set(r.parentId, list);
    }
    return map;
  }, [rows]);
  const roots = byParent.get(null) ?? [];
  const childrenOf = (id: string) => byParent.get(id) ?? [];
  /** Parents a new category may go under: roots and their children (max three levels). */
  const parentOptions = (rows ?? []).filter((r) => r.depth < 2);

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/admin/categories', {
        body: { name: name.trim(), parentId: parentId || null, icon: icon.trim() || null },
        auth: true,
      });
      setName('');
      setIcon('');
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: AdminCategoryRow) {
    try {
      await api(`/api/admin/categories/${row.id}`, {
        method: 'PATCH',
        body: { isActive: !row.isActive },
        auth: true,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    }
  }

  function summary(row: AdminCategoryRow): string {
    const r = row.rules;
    const bits = [
      r.variantAxes.length ? r.variantAxes.map((a) => a.label).join(' × ') : 'single SKU',
      `GST ${describeTaxDefault(r)}`,
      r.returnWindowDays !== null ? `${r.returnWindowDays}d returns` : 'platform returns',
    ];
    if (r.tryOnEligible) bits.push('try-on');
    if (r.attributeSchema.length) bits.push(`${r.attributeSchema.length} spec fields`);
    return bits.join(' · ');
  }

  function CategoryRow({ row }: { row: AdminCategoryRow }) {
    const hasOwnRules = Object.values(row.own).some((v) => v !== null);
    return (
      <div className={`border-t border-gray-100 py-2 ${row.depth === 1 ? 'pl-6' : row.depth === 2 ? 'pl-12' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm">
              {row.icon && <span className="mr-1.5">{row.icon}</span>}
              <span className={row.isActive ? 'font-medium' : 'text-gray-400 line-through'}>
                {row.name}
              </span>{' '}
              <span className="text-xs text-gray-400">
                /{row.slug} · {row.productCount} products
              </span>
            </p>
            <p className="text-[11px] text-gray-400">
              {summary(row)}
              {hasOwnRules ? '' : row.depth > 0 ? ' · inherited' : ''}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(editing === row.id ? null : row.id)}
              className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-100"
            >
              {editing === row.id ? 'Close' : 'Rules'}
            </button>
            <button
              onClick={() => void toggleActive(row)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                row.isActive
                  ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  : 'bg-green-100 text-green-700 hover:bg-green-200'
              }`}
            >
              {row.isActive ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </div>
        {editing === row.id && (
          <RulesEditor
            row={row}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              load();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Categories</h1>
      <p className="mt-1 text-sm text-gray-500">
        Up to three levels deep. Each category carries the marketplace rules for its department —
        variant options, spec sheet, GST default, return window, AI Try-On — and children inherit
        whatever they don&apos;t override.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={(e) => void addCategory(e)} className="mt-4 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          className={field}
        />
        <input
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="Icon (emoji)"
          className={`w-28 ${field}`}
          title="Shown in the category nav bar and mega menu"
        />
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className={`${field} bg-white`}
        >
          <option value="">— top level —</option>
          {parentOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.depth === 1 ? '↳ ' : ''}under {r.name}
            </option>
          ))}
        </select>
        <button
          disabled={busy || name.trim().length < 2}
          className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          Add
        </button>
      </form>

      <div className="mt-5 rounded-2xl border border-gray-100 bg-white p-4">
        {rows === null && <p className="text-sm text-gray-500">Loading…</p>}
        {roots.map((root) => (
          <div key={root.id}>
            <CategoryRow row={root} />
            {childrenOf(root.id).map((child) => (
              <div key={child.id}>
                <CategoryRow row={child} />
                {childrenOf(child.id).map((grandchild) => (
                  <CategoryRow key={grandchild.id} row={grandchild} />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Deactivated categories disappear from the storefront nav/filters; their products stay but
        can be re-categorised.
      </p>
    </div>
  );
}
