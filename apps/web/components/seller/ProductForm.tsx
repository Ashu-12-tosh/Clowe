'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ATTRIBUTE_SUGGESTIONS,
  SHIPPING_TEMPLATES,
  SHIPPING_TEMPLATE_LABELS,
  TAX_RATES,
  sellerProductUpsertSchema,
  type CategoryNode,
  type ProductAttribute,
  type ProductSaveMode,
  type SellerProductDetail,
  type SellerProductUpsertInput,
  type SellerVariantInput,
  type ShippingTemplateValue,
} from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';
import { formatPaise } from '@/lib/format';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

const STEPS = [
  { key: 'BASIC', label: 'Basic info' },
  { key: 'CATEGORY', label: 'Category & attributes' },
  { key: 'MEDIA', label: 'Images & video' },
  { key: 'VARIANTS', label: 'Variants' },
  { key: 'INVENTORY', label: 'Inventory & pricing' },
  { key: 'SHIPPING', label: 'Shipping & SEO' },
  { key: 'REVIEW', label: 'Review' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

const MAX_IMAGES = 8;

interface VariantRow {
  id?: string;
  size: string;
  color: string;
  sku: string;
  price: string; // rupees, as typed
  mrp: string;
  stock: string;
}

const emptyRow: VariantRow = { size: '', color: '', sku: '', price: '', mrp: '', stock: '10' };

/** Character counter shown under an input, e.g. "41/200". */
function Counter({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return (
    <span className={`text-[11px] ${over ? 'text-red-600' : 'text-gray-400'}`}>
      {value.length}/{max}
    </span>
  );
}

interface Props {
  /** Existing product when editing; undefined when creating. */
  initial?: SellerProductDetail;
}

export default function ProductForm({ initial }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<StepKey>('BASIC');
  const [categories, setCategories] = useState<CategoryNode[]>([]);

  // --- Basic ---
  const [title, setTitle] = useState(initial?.title ?? '');
  const [brand, setBrand] = useState(initial?.brand ?? '');
  const [shortDescription, setShortDescription] = useState(initial?.shortDescription ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');

  // --- Category & attributes ---
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '');
  const [attributes, setAttributes] = useState<ProductAttribute[]>(initial?.attributes ?? []);
  const [highlights, setHighlights] = useState<string[]>(initial?.highlights ?? []);

  // --- Media ---
  const [imageUrls, setImageUrls] = useState<string[]>(initial?.imageUrls ?? []);
  const [videoUrl, setVideoUrl] = useState(initial?.videoUrl ?? '');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // --- Variants ---
  const [hasVariants, setHasVariants] = useState((initial?.variants.length ?? 0) > 1);
  const [rows, setRows] = useState<VariantRow[]>(
    initial?.variants.map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      sku: v.sku,
      price: String(v.pricePaise / 100),
      mrp: v.mrpPaise != null ? String(v.mrpPaise / 100) : '',
      stock: String(v.stock),
    })) ?? [{ ...emptyRow, size: 'One Size', color: 'Default' }],
  );

  // --- Inventory / pricing / shipping / SEO ---
  const [taxRate, setTaxRate] = useState<string>(
    initial?.taxRatePercent != null ? String(initial.taxRatePercent) : '',
  );
  const [lowStockAlert, setLowStockAlert] = useState(String(initial?.lowStockAlert ?? 5));
  const [allowBackorders, setAllowBackorders] = useState(initial?.allowBackorders ?? false);
  const [weight, setWeight] = useState(
    initial?.weightGrams != null ? String(initial.weightGrams / 1000) : '',
  );
  const [dims, setDims] = useState({
    l: initial?.lengthMm != null ? String(initial.lengthMm / 10) : '',
    w: initial?.widthMm != null ? String(initial.widthMm / 10) : '',
    h: initial?.heightMm != null ? String(initial.heightMm / 10) : '',
  });
  const [shippingTemplate, setShippingTemplate] = useState<ShippingTemplateValue>(
    initial?.shippingTemplate ?? 'STANDARD',
  );
  const [metaTitle, setMetaTitle] = useState(initial?.metaTitle ?? '');
  const [metaDescription, setMetaDescription] = useState(initial?.metaDescription ?? '');
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [isVisible, setIsVisible] = useState(initial?.isVisible ?? true);
  const [tryOnEnabled, setTryOnEnabled] = useState(initial?.tryOnEnabled ?? true);

  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api<CategoryNode[]>('/api/categories')
      .then(setCategories)
      .catch(() => {});
  }, []);

  // Category path: root → child (the tree the API serves is two levels).
  const rootOf = useMemo(
    () => categories.find((r) => r.children.some((c) => c.id === categoryId)),
    [categories, categoryId],
  );
  const [rootId, setRootId] = useState('');
  useEffect(() => {
    if (rootOf) setRootId(rootOf.id);
  }, [rootOf]);

  const suggestedAttributes = useMemo(() => {
    const slug = categories.find((r) => r.id === rootId)?.slug ?? '';
    return ATTRIBUTE_SUGGESTIONS[slug] ?? ATTRIBUTE_SUGGESTIONS.default;
  }, [categories, rootId]);

  const tags = useMemo(
    () =>
      tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 15),
    [tagsText],
  );

  const variantInputs: SellerVariantInput[] = useMemo(
    () =>
      rows
        .filter((r) => r.size.trim() && r.color.trim() && r.price.trim())
        .map((r) => ({
          id: r.id,
          size: r.size.trim(),
          color: r.color.trim(),
          sku: r.sku.trim() || undefined,
          pricePaise: Math.round(Number(r.price) * 100),
          mrpPaise: r.mrp.trim() ? Math.round(Number(r.mrp) * 100) : null,
          stock: Math.max(0, Math.round(Number(r.stock) || 0)),
        })),
    [rows],
  );

  const cheapest = variantInputs.length
    ? variantInputs.reduce((min, v) => (v.pricePaise < min.pricePaise ? v : min))
    : null;
  const totalStock = variantInputs.reduce((sum, v) => sum + v.stock, 0);

  /** Publish checklist — drives the completeness ring on the right. */
  const checklist = [
    { key: 'basic', label: 'Basic information', done: title.trim().length >= 3 && description.trim().length >= 20 },
    { key: 'category', label: 'Category & attributes', done: !!categoryId },
    { key: 'images', label: 'Images', done: imageUrls.length > 0 },
    { key: 'variants', label: 'Variants', done: variantInputs.length > 0 },
    { key: 'inventory', label: 'Inventory', done: totalStock > 0 },
    { key: 'pricing', label: 'Pricing', done: !!cheapest },
    { key: 'shipping', label: 'Shipping', done: !!weight.trim() },
    { key: 'seo', label: 'SEO & visibility', done: !!metaTitle.trim() || tags.length > 0 },
  ];
  const completeness = Math.round((checklist.filter((c) => c.done).length / checklist.length) * 100);

  function buildPayload(mode: ProductSaveMode): SellerProductUpsertInput {
    return {
      title: title.trim(),
      categoryId,
      brand: brand.trim() || undefined,
      shortDescription: shortDescription.trim() || undefined,
      description: description.trim(),
      imageUrls,
      videoUrl: videoUrl.trim() || undefined,
      attributes: attributes.filter((a) => a.name.trim() && a.value.trim()),
      highlights: highlights.filter((h) => h.trim().length >= 3),
      variants: variantInputs,
      taxRatePercent: taxRate === '' ? null : Number(taxRate),
      weightGrams: weight.trim() ? Math.round(Number(weight) * 1000) : null,
      lengthMm: dims.l.trim() ? Math.round(Number(dims.l) * 10) : null,
      widthMm: dims.w.trim() ? Math.round(Number(dims.w) * 10) : null,
      heightMm: dims.h.trim() ? Math.round(Number(dims.h) * 10) : null,
      shippingTemplate,
      metaTitle: metaTitle.trim() || undefined,
      metaDescription: metaDescription.trim() || undefined,
      tags,
      isVisible,
      tryOnEnabled,
      lowStockAlert: Math.max(0, Math.round(Number(lowStockAlert) || 0)),
      allowBackorders,
      mode,
    };
  }

  async function save(mode: ProductSaveMode) {
    setError('');
    setNotice('');

    const parsed = sellerProductUpsertSchema.safeParse(buildPayload(mode));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join('.') || 'form'}: ${issue.message}`);
      return;
    }

    setBusy(true);
    try {
      if (initial) {
        await api(`/api/seller/products/${initial.id}`, {
          method: 'PUT',
          body: parsed.data,
          auth: true,
        });
      } else {
        await api('/api/seller/products', { body: parsed.data, auth: true });
      }
      router.push('/seller/products');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reach the API');
      setBusy(false);
    }
  }

  async function generateDescription() {
    setError('');
    setAiBusy(true);
    try {
      const categoryName = categories
        .flatMap((root) => root.children)
        .find((c) => c.id === categoryId)?.name;
      const data = await api<{ description: string }>('/api/ai/product-description', {
        body: {
          title: title.trim(),
          brand: brand.trim() || undefined,
          categoryName,
          keywords:
            [shortDescription.trim(), ...attributes.map((a) => `${a.name}: ${a.value}`)]
              .filter(Boolean)
              .join(', ')
              .slice(0, 200) || undefined,
        },
        auth: true,
      });
      setDescription(data.description);
      setNotice('Description generated — edit it before publishing.');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'AI generation failed');
    } finally {
      setAiBusy(false);
    }
  }

  async function onUpload(files: FileList | File[] | null) {
    const list = files ? [...files] : [];
    if (list.length === 0) return;
    setError('');
    setUploading(true);
    try {
      const urls = await uploadImages(list);
      setImageUrls((prev) => [...prev, ...urls].slice(0, MAX_IMAGES));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function setRow(index: number, patch: Partial<VariantRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        {/* --- Step tabs ------------------------------------------------ */}
        <div className="flex flex-wrap gap-1 rounded-2xl border border-gray-100 bg-white p-2">
          {STEPS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStep(s.key)}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                step === s.key
                  ? 'bg-ink-900 text-white'
                  : 'text-gray-500 hover:bg-cream-100 hover:text-ink-900'
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                  step === s.key ? 'bg-white text-ink-900' : 'bg-cream-100 text-gray-500'
                }`}
              >
                {i + 1}
              </span>
              {s.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            {notice}
          </div>
        )}

        {/* --- 1. Basic -------------------------------------------------- */}
        {step === 'BASIC' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">1. Basic information</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Product name *</label>
                  <Counter value={title} max={150} />
                </div>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={150}
                  placeholder="e.g. Classic Cotton Crew Neck T-Shirt"
                  className={`mt-1 ${field}`}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Brand</label>
                <input
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  maxLength={40}
                  placeholder="Your brand name"
                  className={`mt-1 ${field}`}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Tax class (GST)</label>
                <select
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                  className={`mt-1 ${field}`}
                >
                  <option value="">Auto (apparel slab: 5% / 12%)</option>
                  {TAX_RATES.map((r) => (
                    <option key={r} value={r}>
                      GST {r}%
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Short description</label>
                  <Counter value={shortDescription} max={200} />
                </div>
                <input
                  value={shortDescription}
                  onChange={(e) => setShortDescription(e.target.value)}
                  maxLength={200}
                  placeholder="One line shoppers see on cards and search results"
                  className={`mt-1 ${field}`}
                />
              </div>
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Long description * (min 20 chars)</label>
                  <Counter value={description} max={5000} />
                </div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={7}
                  maxLength={5000}
                  placeholder="Fabric, fit, wash care… or let AI write it from the title"
                  className={`mt-1 ${field}`}
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-cream-50 px-3 py-2">
                  <p className="text-xs text-gray-600">
                    <span className="font-semibold text-ink-900">✦ AI suggestion</span> — writes a
                    description from your title, category and attributes.
                  </p>
                  <button
                    type="button"
                    disabled={aiBusy || title.trim().length < 3}
                    onClick={() => void generateDescription()}
                    title={title.trim().length < 3 ? 'Enter a product name first' : undefined}
                    className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-40"
                  >
                    {aiBusy ? 'Writing…' : '✦ Generate with AI'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* --- 2. Category & attributes ---------------------------------- */}
        {step === 'CATEGORY' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">2. Category &amp; attributes</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Department *</label>
                <select
                  value={rootId}
                  onChange={(e) => {
                    setRootId(e.target.value);
                    setCategoryId('');
                  }}
                  className={`mt-1 ${field}`}
                >
                  <option value="">Select…</option>
                  {categories.map((root) => (
                    <option key={root.id} value={root.id}>
                      {root.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">Category *</label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  disabled={!rootId}
                  className={`mt-1 ${field} disabled:bg-gray-50`}
                >
                  <option value="">Select…</option>
                  {categories
                    .find((r) => r.id === rootId)
                    ?.children.map((child) => (
                      <option key={child.id} value={child.id}>
                        {child.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Key attributes</label>
                <button
                  type="button"
                  onClick={() => setAttributes((prev) => [...prev, { name: '', value: '' }])}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold hover:bg-gray-50"
                >
                  ＋ Add attribute
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-400">
                The spec sheet shoppers see on the product page. Suggested for this department:
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {suggestedAttributes
                  .filter((name) => !attributes.some((a) => a.name === name))
                  .map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setAttributes((prev) => [...prev, { name, value: '' }])}
                      className="rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-cream-200"
                    >
                      ＋ {name}
                    </button>
                  ))}
              </div>

              <div className="mt-3 space-y-2">
                {attributes.map((attr, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={attr.name}
                      onChange={(e) =>
                        setAttributes((prev) =>
                          prev.map((a, j) => (i === j ? { ...a, name: e.target.value } : a)),
                        )
                      }
                      placeholder="Attribute (e.g. Fabric)"
                      className={`${field} max-w-52`}
                    />
                    <input
                      value={attr.value}
                      onChange={(e) =>
                        setAttributes((prev) =>
                          prev.map((a, j) => (i === j ? { ...a, value: e.target.value } : a)),
                        )
                      }
                      placeholder="Value (e.g. 100% cotton)"
                      className={field}
                    />
                    <button
                      type="button"
                      onClick={() => setAttributes((prev) => prev.filter((_, j) => j !== i))}
                      className="px-2 text-red-500"
                      aria-label="Remove attribute"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {attributes.length === 0 && (
                  <p className="text-xs text-gray-400">No attributes yet.</p>
                )}
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Key highlights</label>
                <button
                  type="button"
                  onClick={() => setHighlights((prev) => [...prev, ''])}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold hover:bg-gray-50"
                >
                  ＋ Add highlight
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-400">
                Short bullets shown above the description on the product page.
              </p>
              <div className="mt-2 space-y-2">
                {highlights.map((h, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={h}
                      onChange={(e) =>
                        setHighlights((prev) => prev.map((x, j) => (i === j ? e.target.value : x)))
                      }
                      placeholder="e.g. Breathable combed cotton"
                      className={field}
                    />
                    <button
                      type="button"
                      onClick={() => setHighlights((prev) => prev.filter((_, j) => j !== i))}
                      className="px-2 text-red-500"
                      aria-label="Remove highlight"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* --- 3. Media --------------------------------------------------- */}
        {step === 'MEDIA' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">3. Images &amp; video</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              First image is the main one. JPG / PNG / WebP, up to {MAX_IMAGES} images.
            </p>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void onUpload(e.dataTransfer.files);
              }}
              className={`mt-3 rounded-xl border-2 border-dashed p-6 text-center transition ${
                dragOver ? 'border-brand-600 bg-cream-50' : 'border-gray-300'
              }`}
            >
              <p className="text-2xl">🖼</p>
              <p className="mt-1 text-sm text-gray-600">Drag &amp; drop images here</p>
              <label className="mt-2 inline-block cursor-pointer rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700">
                {uploading ? 'Uploading…' : 'Upload images'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    void onUpload(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-3">
              {imageUrls.map((url, i) => (
                <div key={url} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt=""
                    className={`h-28 w-24 rounded-lg border-2 object-cover ${
                      i === 0 ? 'border-brand-600' : 'border-gray-200'
                    }`}
                  />
                  {i === 0 && (
                    <span className="absolute bottom-1 left-1 rounded bg-ink-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      Main
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setImageUrls((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white"
                    aria-label="Remove image"
                  >
                    ×
                  </button>
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setImageUrls((prev) => {
                          const next = [...prev];
                          [next[i - 1], next[i]] = [next[i], next[i - 1]];
                          return next;
                        })
                      }
                      className="absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-ink-900 text-[10px] text-white"
                      title="Move earlier"
                    >
                      ‹
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-4">
              <label className="text-sm font-medium">Product video (optional)</label>
              <input
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="Paste a YouTube or Vimeo link"
                className={`mt-1 ${field}`}
              />
            </div>
          </section>
        )}

        {/* --- 4. Variants ------------------------------------------------ */}
        {step === 'VARIANTS' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-ink-900">4. Variants</h2>
                <p className="text-xs text-gray-400">
                  Each size × colour combination is its own sellable unit with its own stock.
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-gray-600">
                This product has variants
                <input
                  type="checkbox"
                  checked={hasVariants}
                  onChange={(e) => {
                    setHasVariants(e.target.checked);
                    if (!e.target.checked) setRows((prev) => prev.slice(0, 1));
                  }}
                  className="h-4 w-4 accent-[#B8860B]"
                />
              </label>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="pb-2 pr-2">Size</th>
                    <th className="pb-2 pr-2">Colour</th>
                    <th className="pb-2 pr-2">SKU</th>
                    <th className="pb-2 pr-2">Price (₹) *</th>
                    <th className="pb-2 pr-2">MRP (₹)</th>
                    <th className="pb-2 pr-2">Stock</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td className="pr-2 pt-1">
                        <input
                          value={row.size}
                          onChange={(e) => setRow(i, { size: e.target.value })}
                          className={field}
                          placeholder="M"
                        />
                      </td>
                      <td className="pr-2 pt-1">
                        <input
                          value={row.color}
                          onChange={(e) => setRow(i, { color: e.target.value })}
                          className={field}
                          placeholder="Black"
                        />
                      </td>
                      <td className="pr-2 pt-1">
                        <input
                          value={row.sku}
                          onChange={(e) => setRow(i, { sku: e.target.value })}
                          className={field}
                          placeholder="auto"
                        />
                      </td>
                      <td className="pr-2 pt-1">
                        <input
                          type="number"
                          min={1}
                          value={row.price}
                          onChange={(e) => setRow(i, { price: e.target.value })}
                          className={field}
                          placeholder="499"
                        />
                      </td>
                      <td className="pr-2 pt-1">
                        <input
                          type="number"
                          min={1}
                          value={row.mrp}
                          onChange={(e) => setRow(i, { mrp: e.target.value })}
                          className={field}
                          placeholder="799"
                        />
                      </td>
                      <td className="pr-2 pt-1">
                        <input
                          type="number"
                          min={0}
                          value={row.stock}
                          onChange={(e) => setRow(i, { stock: e.target.value })}
                          className={field}
                        />
                      </td>
                      <td className="pt-1">
                        <button
                          type="button"
                          onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                          disabled={rows.length === 1}
                          className="text-red-500 disabled:opacity-30"
                          aria-label="Remove variant"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hasVariants && (
              <button
                type="button"
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    {
                      ...emptyRow,
                      color: prev[prev.length - 1]?.color ?? '',
                      price: prev[prev.length - 1]?.price ?? '',
                      mrp: prev[prev.length - 1]?.mrp ?? '',
                    },
                  ])
                }
                className="mt-2 text-sm font-medium text-brand-600 hover:underline"
              >
                ＋ Add variant row
              </button>
            )}
          </section>
        )}

        {/* --- 5. Inventory & pricing -------------------------------------- */}
        {step === 'INVENTORY' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">5. Inventory &amp; pricing</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Low stock alert</label>
                <input
                  type="number"
                  min={0}
                  value={lowStockAlert}
                  onChange={(e) => setLowStockAlert(e.target.value)}
                  className={`mt-1 ${field}`}
                />
                <p className="mt-1 text-xs text-gray-400">
                  Variants at or below this level are flagged on your dashboard.
                </p>
              </div>
              <div>
                <label className="text-sm font-medium">Tax class</label>
                <select
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                  className={`mt-1 ${field}`}
                >
                  <option value="">Auto (apparel slab: 5% / 12%)</option>
                  {TAX_RATES.map((r) => (
                    <option key={r} value={r}>
                      GST {r}%
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-400">
                  Used on the tax invoice you issue for each order.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={allowBackorders}
                  onChange={(e) => setAllowBackorders(e.target.checked)}
                  className="h-4 w-4 accent-[#B8860B]"
                />
                Allow backorders (keep selling when stock hits zero)
              </label>
            </div>

            <div className="mt-4 rounded-xl bg-cream-50 p-3 text-xs">
              <p className="font-semibold text-ink-900">Pricing summary</p>
              <p className="mt-1 text-gray-600">
                {cheapest ? (
                  <>
                    Listing price {formatPaise(cheapest.pricePaise)}
                    {cheapest.mrpPaise ? (
                      <>
                        {' '}
                        · MRP {formatPaise(cheapest.mrpPaise)} ·{' '}
                        {Math.round(
                          ((cheapest.mrpPaise - cheapest.pricePaise) / cheapest.mrpPaise) * 100,
                        )}
                        % off
                      </>
                    ) : null}{' '}
                    · {totalStock} unit(s) across {variantInputs.length} variant(s)
                  </>
                ) : (
                  'Add a variant with a price to see the listing price.'
                )}
              </p>
            </div>
          </section>
        )}

        {/* --- 6. Shipping & SEO ------------------------------------------ */}
        {step === 'SHIPPING' && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="text-sm font-bold text-ink-900">6. Shipping</h2>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-sm font-medium">Item weight (kg)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    className={`mt-1 ${field}`}
                    placeholder="0.35"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Shipping template</label>
                  <select
                    value={shippingTemplate}
                    onChange={(e) => setShippingTemplate(e.target.value as ShippingTemplateValue)}
                    className={`mt-1 ${field}`}
                  >
                    {SHIPPING_TEMPLATES.map((t) => (
                      <option key={t} value={t}>
                        {SHIPPING_TEMPLATE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="text-sm font-medium">Dimensions (cm)</label>
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    {(['l', 'w', 'h'] as const).map((key) => (
                      <div key={key}>
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={dims[key]}
                          onChange={(e) => setDims((d) => ({ ...d, [key]: e.target.value }))}
                          className={field}
                          placeholder={key.toUpperCase()}
                        />
                        <p className="mt-0.5 text-center text-[11px] text-gray-400">
                          {key === 'l' ? 'Length' : key === 'w' ? 'Width' : 'Height'}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-white p-4">
              <h2 className="text-sm font-bold text-ink-900">7. SEO &amp; visibility</h2>
              <div className="mt-3 space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Meta title</label>
                    <Counter value={metaTitle} max={70} />
                  </div>
                  <input
                    value={metaTitle}
                    onChange={(e) => setMetaTitle(e.target.value)}
                    maxLength={70}
                    placeholder={title || 'Falls back to the product name'}
                    className={`mt-1 ${field}`}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Meta description</label>
                    <Counter value={metaDescription} max={160} />
                  </div>
                  <textarea
                    value={metaDescription}
                    onChange={(e) => setMetaDescription(e.target.value)}
                    rows={2}
                    maxLength={160}
                    placeholder="What a shopper sees in search results"
                    className={`mt-1 ${field}`}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Tags / keywords</label>
                    <span className="text-[11px] text-gray-400">{tags.length}/15</span>
                  </div>
                  <input
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    placeholder="cotton t-shirt, summer, casual"
                    className={`mt-1 ${field}`}
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>

                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={isVisible}
                    onChange={(e) => setIsVisible(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-[#B8860B]"
                  />
                  <span>
                    Show on storefront
                    <span className="block text-xs text-gray-400">
                      Unticking hides an approved listing from browsing and search without
                      archiving it.
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={tryOnEnabled}
                    onChange={(e) => setTryOnEnabled(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-[#B8860B]"
                  />
                  <span>
                    Enable AI Try-On
                    <span className="block text-xs text-gray-400">
                      For apparel, footwear and eyewear. The platform&apos;s minimum-price rule
                      still applies on top of this.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </section>
        )}

        {/* --- 7. Review --------------------------------------------------- */}
        {step === 'REVIEW' && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Review &amp; publish</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              {initial
                ? 'Saved edits go back to the admin for re-approval.'
                : 'New listings go live once the admin approves them.'}
            </p>

            <ul className="mt-3 space-y-2 text-sm">
              {checklist.map((c) => (
                <li key={c.key} className="flex items-center gap-2">
                  <span className={c.done ? 'text-green-600' : 'text-gray-300'}>
                    {c.done ? '✓' : '○'}
                  </span>
                  <span className={c.done ? 'text-ink-900' : 'text-gray-500'}>{c.label}</span>
                </li>
              ))}
            </ul>

            <dl className="mt-4 grid gap-2 border-t border-gray-100 pt-3 text-xs sm:grid-cols-2">
              <div className="flex justify-between">
                <dt className="text-gray-500">Variants</dt>
                <dd className="font-semibold">{variantInputs.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Total stock</dt>
                <dd className="font-semibold">{totalStock}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Images</dt>
                <dd className="font-semibold">{imageUrls.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Attributes</dt>
                <dd className="font-semibold">{attributes.filter((a) => a.value.trim()).length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Storefront</dt>
                <dd className="font-semibold">{isVisible ? 'Visible' : 'Hidden'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">AI Try-On</dt>
                <dd className="font-semibold">{tryOnEnabled ? 'Enabled' : 'Off'}</dd>
              </div>
            </dl>
          </section>
        )}

        {/* --- Step nav + actions ------------------------------------------ */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-100 bg-white p-3">
          <button
            type="button"
            disabled={stepIndex === 0}
            onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].key)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold hover:bg-gray-50 disabled:opacity-40"
          >
            ‹ Back
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || uploading || title.trim().length < 3 || !categoryId}
              onClick={() => void save('DRAFT')}
              title="Saves privately — no admin review, finish it later"
              className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-50 disabled:opacity-40"
            >
              Save as draft
            </button>
            {stepIndex < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStep(STEPS[stepIndex + 1].key)}
                className="rounded-lg bg-ink-900 px-5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
              >
                Next ›
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || uploading}
                onClick={() => void save('SUBMIT')}
                className="rounded-lg bg-brand-600 px-5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? 'Saving…' : initial ? 'Save & resubmit' : 'Publish product'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* --- Sidebar: live preview + completeness ------------------------- */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <h2 className="text-sm font-bold text-ink-900">Product preview</h2>
          <p className="text-[11px] text-gray-400">How your listing appears to shoppers.</p>
          <div className="mt-3 overflow-hidden rounded-xl border border-gray-100">
            {imageUrls[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrls[0]} alt="" className="aspect-[3/4] w-full object-cover" />
            ) : (
              <div className="flex aspect-[3/4] w-full items-center justify-center bg-cream-100 text-xs text-gray-400">
                Add an image
              </div>
            )}
            <div className="p-3">
              <p className="text-sm font-semibold text-ink-900">
                {title.trim() || 'Your product name'}
              </p>
              {shortDescription.trim() && (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-gray-500">{shortDescription}</p>
              )}
              <p className="mt-1.5">
                <span className="font-display text-lg font-bold text-ink-900">
                  {cheapest ? formatPaise(cheapest.pricePaise) : '₹—'}
                </span>
                {cheapest?.mrpPaise ? (
                  <>
                    <span className="ml-1.5 text-xs text-gray-400 line-through">
                      {formatPaise(cheapest.mrpPaise)}
                    </span>
                    <span className="ml-1.5 text-xs font-semibold text-green-700">
                      {Math.round(
                        ((cheapest.mrpPaise - cheapest.pricePaise) / cheapest.mrpPaise) * 100,
                      )}
                      % OFF
                    </span>
                  </>
                ) : null}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-400">Inclusive of all taxes</p>
              <p className="mt-1 text-[11px] font-semibold text-green-700">
                {totalStock > 0 ? 'In stock' : allowBackorders ? 'Backorder' : 'Out of stock'}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <div className="flex items-center gap-3">
            <div
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
              style={{
                background: `conic-gradient(#B8860B ${completeness * 3.6}deg, #F1EFEA 0deg)`,
              }}
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-xs font-bold text-ink-900">
                {completeness}%
              </span>
            </div>
            <div>
              <h2 className="text-sm font-bold text-ink-900">Product completeness</h2>
              <p className="text-[11px] text-gray-400">
                {completeness === 100
                  ? 'Everything filled in — ready to publish.'
                  : 'Complete the remaining fields for a stronger listing.'}
              </p>
            </div>
          </div>
          <ul className="mt-3 space-y-1.5 text-xs">
            {checklist.map((c) => (
              <li key={c.key} className="flex items-center gap-2">
                <span className={c.done ? 'text-green-600' : 'text-gray-300'}>
                  {c.done ? '✓' : '○'}
                </span>
                <span className={c.done ? 'text-ink-900' : 'text-gray-500'}>{c.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <h2 className="text-sm font-bold text-ink-900">Publishing guidelines</h2>
          <ul className="mt-2 space-y-1.5 text-[11px] text-gray-500">
            <li>• Use clear, well-lit images on a plain background.</li>
            <li>• Describe fabric/material, fit and care honestly.</li>
            <li>• Keep promotional words out of the product name.</li>
            <li>• Set stock accurately — overselling hurts your seller score.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
