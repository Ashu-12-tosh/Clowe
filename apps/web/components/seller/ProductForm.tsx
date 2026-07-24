'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  sellerProductUpsertSchema,
  type CategoryNode,
  type SellerProductDetail,
  type SellerProductUpsertInput,
  type SellerVariantInput,
} from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

interface VariantRow {
  id?: string;
  size: string;
  color: string;
  price: string; // rupees, as typed
  mrp: string;
  stock: string;
}

const emptyRow: VariantRow = { size: '', color: '', price: '', mrp: '', stock: '10' };

interface Props {
  /** Existing product when editing; undefined when creating. */
  initial?: SellerProductDetail;
}

export default function ProductForm({ initial }: Props) {
  const router = useRouter();
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [brand, setBrand] = useState(initial?.brand ?? '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [imageUrls, setImageUrls] = useState<string[]>(initial?.imageUrls ?? []);
  const [rows, setRows] = useState<VariantRow[]>(
    initial?.variants.map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      price: String(v.pricePaise / 100),
      mrp: v.mrpPaise != null ? String(v.mrpPaise / 100) : '',
      stock: String(v.stock),
    })) ?? [{ ...emptyRow }],
  );
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<CategoryNode[]>('/api/categories').then(setCategories).catch(() => {});
  }, []);

  const [aiBusy, setAiBusy] = useState(false);

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
          // Existing description text is treated as the seller's keywords/basics.
          keywords: description.trim().slice(0, 200) || undefined,
        },
        auth: true,
      });
      setDescription(data.description);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'AI generation failed');
    } finally {
      setAiBusy(false);
    }
  }

  function setRow(index: number, patch: Partial<VariantRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError('');
    setUploading(true);
    try {
      const urls = await uploadImages([...files]);
      setImageUrls((prev) => [...prev, ...urls].slice(0, 6));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const variants: SellerVariantInput[] = rows
      .filter((r) => r.size.trim() && r.color.trim())
      .map((r) => ({
        id: r.id,
        size: r.size.trim(),
        color: r.color.trim(),
        pricePaise: Math.round(Number(r.price) * 100),
        mrpPaise: r.mrp.trim() ? Math.round(Number(r.mrp) * 100) : null,
        stock: Math.max(0, Math.round(Number(r.stock) || 0)),
      }));

    const payload: SellerProductUpsertInput = {
      title: title.trim(),
      categoryId,
      brand: brand.trim() || undefined,
      description: description.trim(),
      imageUrls,
      variants,
    };

    const parsed = sellerProductUpsertSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join('.')}: ${issue.message}`);
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

  return (
    <form className="space-y-5" onSubmit={(e) => void onSubmit(e)}>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="text-sm font-medium">Title *</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={`mt-1 ${field}`} placeholder="e.g. Classic Cotton Crew Neck T-Shirt" />
        </div>
        <div>
          <label className="text-sm font-medium">Brand</label>
          <input value={brand} onChange={(e) => setBrand(e.target.value)} className={`mt-1 ${field}`} placeholder="Your brand name" />
        </div>
        <div>
          <label className="text-sm font-medium">Category *</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`mt-1 ${field}`}>
            <option value="">Select category…</option>
            {categories.map((root) => (
              <optgroup key={root.id} label={root.name}>
                {root.children.map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Description * (min 20 chars)</label>
            <button
              type="button"
              disabled={aiBusy || title.trim().length < 3}
              onClick={() => void generateDescription()}
              title={title.trim().length < 3 ? 'Enter a title first' : 'Let AI write the description'}
              className="rounded-full bg-gradient-to-r from-purple-600 to-brand-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
            >
              {aiBusy ? 'Writing…' : '✨ Generate with AI'}
            </button>
          </div>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`mt-1 ${field}`} placeholder="Fabric, fit, wash care… or let AI write it from the title" />
        </div>
      </div>

      {/* ---------------- Images ---------------- */}
      <div>
        <label className="text-sm font-medium">Images * (1–6, JPG/PNG/WebP, max 5 MB each)</label>
        <div className="mt-2 flex flex-wrap gap-3">
          {imageUrls.map((url, i) => (
            <div key={url} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="h-24 w-20 rounded-lg border border-gray-200 object-cover" />
              <button
                type="button"
                onClick={() => setImageUrls((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white"
                aria-label="Remove image"
              >
                ×
              </button>
            </div>
          ))}
          {imageUrls.length < 6 && (
            <label className="flex h-24 w-20 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-gray-400 hover:border-brand-600 hover:text-brand-600">
              <span className="text-xl">+</span>
              <span className="text-[10px]">{uploading ? 'Uploading…' : 'Add'}</span>
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
          )}
        </div>
      </div>

      {/* ---------------- Variants ---------------- */}
      <div>
        <label className="text-sm font-medium">Variants * (size × colour)</label>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="pb-2 pr-2">Size</th>
                <th className="pb-2 pr-2">Colour</th>
                <th className="pb-2 pr-2">Price (₹)</th>
                <th className="pb-2 pr-2">MRP (₹)</th>
                <th className="pb-2 pr-2">Stock</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td className="pr-2 pt-1"><input value={row.size} onChange={(e) => setRow(i, { size: e.target.value })} className={field} placeholder="M" /></td>
                  <td className="pr-2 pt-1"><input value={row.color} onChange={(e) => setRow(i, { color: e.target.value })} className={field} placeholder="Black" /></td>
                  <td className="pr-2 pt-1"><input type="number" min={1} value={row.price} onChange={(e) => setRow(i, { price: e.target.value })} className={field} placeholder="499" /></td>
                  <td className="pr-2 pt-1"><input type="number" min={1} value={row.mrp} onChange={(e) => setRow(i, { mrp: e.target.value })} className={field} placeholder="799" /></td>
                  <td className="pr-2 pt-1"><input type="number" min={0} value={row.stock} onChange={(e) => setRow(i, { stock: e.target.value })} className={field} /></td>
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
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, { ...emptyRow, color: prev[prev.length - 1]?.color ?? '' }])}
          className="mt-2 text-sm font-medium text-brand-600 hover:underline"
        >
          + Add variant row
        </button>
      </div>

      <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
        <button
          type="submit"
          disabled={busy || uploading}
          className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : initial ? 'Save changes (goes to re-approval)' : 'Submit for approval'}
        </button>
        <p className="text-xs text-gray-500">
          {initial
            ? 'Edited products are reviewed again before going live.'
            : 'New products go live after admin approval.'}
        </p>
      </div>
    </form>
  );
}
