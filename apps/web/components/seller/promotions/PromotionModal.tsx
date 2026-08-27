'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  PROMOTION_KINDS,
  PROMOTION_KIND_LABELS,
  PROMOTION_SCOPES,
  PROMOTION_SCOPE_LABELS,
  promotionUpsertSchema,
  type CategoryNode,
  type PromotionKindValue,
  type PromotionScopeValue,
  type SellerPromotionRow,
  type SellerProductPage,
  type SellerProductRow,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

/** ISO string → value a datetime-local input accepts. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultWindow(): { start: string; end: string } {
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 14);
  return { start: toLocalInput(start.toISOString()), end: toLocalInput(end.toISOString()) };
}

export default function PromotionModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: SellerPromotionRow;
  onClose: () => void;
  onSaved: (row: SellerPromotionRow) => void;
}) {
  const window0 = useMemo(defaultWindow, []);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [scope, setScope] = useState<PromotionScopeValue>(initial?.scope ?? 'STORE');
  const [kind, setKind] = useState<PromotionKindValue>(initial?.kind ?? 'PERCENT');
  const [value, setValue] = useState(
    initial ? String(initial.kind === 'PERCENT' ? initial.value : initial.value / 100) : '10',
  );
  const [maxDiscount, setMaxDiscount] = useState(
    initial?.maxDiscountPaise != null ? String(initial.maxDiscountPaise / 100) : '',
  );
  const [minOrder, setMinOrder] = useState(
    initial ? String(initial.minOrderPaise / 100) : '',
  );
  const [startAt, setStartAt] = useState(
    initial ? toLocalInput(initial.startAt) : window0.start,
  );
  const [endAt, setEndAt] = useState(initial ? toLocalInput(initial.endAt) : window0.end);
  const [usageLimit, setUsageLimit] = useState(
    initial?.usageLimit != null ? String(initial.usageLimit) : '',
  );
  const [perUserLimit, setPerUserLimit] = useState(
    initial?.perUserLimit != null ? String(initial.perUserLimit) : '1',
  );
  const [productIds, setProductIds] = useState<string[]>(initial?.productIds ?? []);
  const [categoryIds, setCategoryIds] = useState<string[]>(initial?.categoryIds ?? []);
  const [isFeatured, setIsFeatured] = useState(initial?.isFeatured ?? false);

  const [products, setProducts] = useState<SellerProductRow[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<SellerProductPage>('/api/seller/products?pageSize=100&state=ACTIVE', { auth: true })
      .then((page) => setProducts(page.rows))
      .catch(() => setProducts([]));
    api<CategoryNode[]>('/api/categories')
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  async function save(state: 'DRAFT' | 'ACTIVE') {
    setError('');
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      code: code.trim().toUpperCase() || undefined,
      scope,
      kind,
      value:
        kind === 'PERCENT'
          ? Math.round(Number(value) || 0)
          : Math.round((Number(value) || 0) * 100),
      maxDiscountPaise: maxDiscount.trim() ? Math.round(Number(maxDiscount) * 100) : null,
      minOrderPaise: minOrder.trim() ? Math.round(Number(minOrder) * 100) : 0,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      usageLimit: usageLimit.trim() ? Math.round(Number(usageLimit)) : null,
      perUserLimit: perUserLimit.trim() ? Math.round(Number(perUserLimit)) : null,
      productIds,
      categoryIds,
      isFeatured,
      state,
    };

    const parsed = promotionUpsertSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join('.') || 'form'}: ${issue.message}`);
      return;
    }

    setBusy(true);
    try {
      const row = initial
        ? await api<SellerPromotionRow>(`/api/seller/promotions/${initial.id}`, {
            method: 'PUT',
            body: parsed.data,
            auth: true,
          })
        : await api<SellerPromotionRow>('/api/seller/promotions', {
            body: parsed.data,
            auth: true,
          });
      onSaved(row);
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the promotion');
    } finally {
      setBusy(false);
    }
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4" onClick={onClose}>
      <div
        className="my-8 w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-ink-900">
              {initial ? 'Edit promotion' : 'Create promotion'}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              The discount comes off your line price at checkout and out of your payout.
            </p>
          </div>
          <button onClick={onClose} className="rounded-full px-2 py-1 text-gray-500 hover:bg-gray-100">
            ✕
          </button>
        </div>

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold text-gray-500">Promotion name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="e.g. Summer Sale"
                className={`mt-1 ${field}`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Code (optional — blank applies automatically)
              </label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={16}
                placeholder="SUMMER25"
                className={`mt-1 ${field} uppercase`}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs font-semibold text-gray-500">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
                placeholder="Shown to shoppers when the offer applies"
                className={`mt-1 ${field}`}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="text-xs font-semibold text-gray-500">Applies to</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as PromotionScopeValue)}
                className={`mt-1 ${field}`}
              >
                {PROMOTION_SCOPES.map((s) => (
                  <option key={s} value={s}>
                    {PROMOTION_SCOPE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">Discount type</label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as PromotionKindValue)}
                className={`mt-1 ${field}`}
              >
                {PROMOTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PROMOTION_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">
                {kind === 'PERCENT' ? 'Percent off (max 90)' : 'Amount off (₹)'}
              </label>
              <input
                type="number"
                min={1}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className={`mt-1 ${field}`}
              />
            </div>
          </div>

          {scope === 'PRODUCT' && (
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Products ({productIds.length} selected)
              </label>
              <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-gray-200 p-2">
                {products.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      checked={productIds.includes(p.id)}
                      onChange={() => setProductIds((prev) => toggle(prev, p.id))}
                      className="h-3.5 w-3.5 accent-[#B8860B]"
                    />
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    <span className="text-gray-400">₹{Math.round(p.pricePaise / 100)}</span>
                  </label>
                ))}
                {products.length === 0 && (
                  <p className="py-2 text-xs text-gray-400">No active products to target.</p>
                )}
              </div>
            </div>
          )}

          {scope === 'CATEGORY' && (
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Categories ({categoryIds.length} selected)
              </label>
              <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-gray-200 p-2">
                {categories.map((root) => (
                  <div key={root.id} className="mb-1.5">
                    <label className="flex items-center gap-2 py-0.5 text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={categoryIds.includes(root.id)}
                        onChange={() => setCategoryIds((prev) => toggle(prev, root.id))}
                        className="h-3.5 w-3.5 accent-[#B8860B]"
                      />
                      {root.name} (whole department)
                    </label>
                    <div className="ml-5">
                      {root.children.map((child) => (
                        <label key={child.id} className="flex items-center gap-2 py-0.5 text-xs">
                          <input
                            type="checkbox"
                            checked={categoryIds.includes(child.id)}
                            onChange={() => setCategoryIds((prev) => toggle(prev, child.id))}
                            className="h-3.5 w-3.5 accent-[#B8860B]"
                          />
                          {child.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold text-gray-500">Starts</label>
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className={`mt-1 ${field}`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">Ends</label>
              <input
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                className={`mt-1 ${field}`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Max discount per order (₹, optional)
              </label>
              <input
                type="number"
                min={0}
                value={maxDiscount}
                onChange={(e) => setMaxDiscount(e.target.value)}
                placeholder="No cap"
                className={`mt-1 ${field}`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Minimum order from your shop (₹)
              </label>
              <input
                type="number"
                min={0}
                value={minOrder}
                onChange={(e) => setMinOrder(e.target.value)}
                placeholder="0"
                className={`mt-1 ${field}`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Total redemptions (blank = unlimited)
              </label>
              <input
                type="number"
                min={1}
                value={usageLimit}
                onChange={(e) => setUsageLimit(e.target.value)}
                placeholder="Unlimited"
                className={`mt-1 ${field}`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Per shopper (blank = unlimited)
              </label>
              <input
                type="number"
                min={1}
                value={perUserLimit}
                onChange={(e) => setPerUserLimit(e.target.value)}
                placeholder="Unlimited"
                className={`mt-1 ${field}`}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isFeatured}
              onChange={(e) => setIsFeatured(e.target.checked)}
              className="h-4 w-4 accent-[#B8860B]"
            />
            Mark as featured in your promotions list
          </label>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void save('DRAFT')}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-bold uppercase tracking-wide hover:bg-gray-50 disabled:opacity-50"
          >
            Save as draft
          </button>
          <button
            onClick={() => void save('ACTIVE')}
            disabled={busy}
            className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Launch promotion'}
          </button>
        </div>
      </div>
    </div>
  );
}
