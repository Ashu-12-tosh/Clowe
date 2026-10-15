'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  IMAGE_SLOTS,
  bannerImageProblem,
  categoryBannerUpsertSchema,
  type AdminCategoryBannerRow,
  type AdminCategoryRow,
  type BannerImageModeValue,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { issuesToFieldErrors, useFieldErrors } from '@/lib/fieldErrors';
import { toast } from '@/lib/toast';
import { usePending } from '@/lib/usePending';
import FieldError from '@/components/FieldError';
import Spinner from '@/components/Spinner';
import ImageUploadField from '@/components/admin/ImageUploadField';
import BannerModeFields from '@/components/admin/BannerModeFields';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';
const labelClass = 'text-xs font-semibold text-gray-700';

const EMPTY = {
  eyebrow: '',
  headline: '',
  highlight: '',
  subtext: '',
  imageUrl: '',
  primaryLabel: 'Shop Now',
  primaryHref: '',
  imageMode: 'DESIGNED' as BannerImageModeValue,
  altText: '',
  mobileImageUrl: '',
};
type Form = typeof EMPTY;

function formOf(row: AdminCategoryBannerRow): Form {
  return {
    eyebrow: row.eyebrow ?? '',
    headline: row.headline,
    highlight: row.highlight ?? '',
    subtext: row.subtext ?? '',
    imageUrl: row.imageUrl ?? '',
    primaryLabel: row.primaryLabel,
    primaryHref: row.primaryHref ?? '',
    imageMode: row.imageMode,
    altText: row.altText ?? '',
    mobileImageUrl: row.mobileImageUrl ?? '',
  };
}

/**
 * The carousel at the top of a category's landing page (/category/<slug>).
 * A category with none shows no carousel.
 */
export default function AdminCategoryBannersPage() {
  const [categories, setCategories] = useState<AdminCategoryRow[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [rows, setRows] = useState<AdminCategoryBannerRow[] | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { run, isPending } = usePending();
  const { errors: fieldErrors, show: showFieldErrors, fromError } = useFieldErrors();

  useEffect(() => {
    api<AdminCategoryRow[]>('/api/admin/categories', { auth: true })
      .then((list) => {
        setCategories(list);
        const wanted = new URLSearchParams(window.location.search).get('category');
        setCategoryId((current) => current || (list.find((c) => c.id === wanted) ?? list.find((c) => c.depth === 0))?.id || '');
      })
      .catch(() => setError('Could not load the categories'));
  }, []);

  const load = useCallback(() => {
    if (!categoryId) return;
    setRows(null);
    api<AdminCategoryBannerRow[]>(`/api/admin/category-banners?categoryId=${encodeURIComponent(categoryId)}`, { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [categoryId]);
  useEffect(load, [load]);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function open(target: AdminCategoryBannerRow | 'new') {
    setForm(target === 'new' ? EMPTY : formOf(target));
    setEditing(target === 'new' ? 'new' : target.id);
    showFieldErrors({});
    setError('');
  }

  const category = categories.find((c) => c.id === categoryId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !editing || !categoryId) return;
    setError('');
    const body = {
      categoryId,
      eyebrow: form.eyebrow.trim() || null,
      headline: form.headline.trim(),
      highlight: form.highlight.trim() || null,
      subtext: form.subtext.trim() || null,
      imageUrl: form.imageUrl.trim() || null,
      primaryLabel: form.primaryLabel.trim() || 'Shop Now',
      primaryHref: form.primaryHref.trim() || null,
      imageMode: form.imageMode,
      altText: form.altText.trim() || null,
      mobileImageUrl: form.mobileImageUrl.trim() || null,
      ...(editing === 'new' ? { sortOrder: rows?.length ?? 0 } : {}),
    };
    const checked = categoryBannerUpsertSchema.safeParse(body);
    const problems = checked.success ? {} : issuesToFieldErrors(checked.error.issues);
    const image = bannerImageProblem(body);
    if (image && !problems[image.field]) problems[image.field] = image.message;
    if (showFieldErrors(problems)) {
      toast.error('Not saved: fix the fields marked in red');
      return;
    }
    setBusy(true);
    try {
      await api(editing === 'new' ? '/api/admin/category-banners' : `/api/admin/category-banners/${editing}`, {
        method: editing === 'new' ? 'POST' : 'PATCH',
        body,
        auth: true,
        success: `${editing === 'new' ? 'Banner created' : 'Banner saved'} — live on the ${category?.name ?? 'category'} page`,
      });
      setEditing(null);
      setForm(EMPTY);
      load();
    } catch (err) {
      fromError(err);
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await run(id, async () => {
      try {
        await api(`/api/admin/category-banners/${id}`, {
          method: 'PATCH',
          body,
          auth: true,
          success: `Banner ${body.isActive ? 'activated' : 'deactivated'}`,
        });
        load();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      }
    });
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this banner?')) return;
    await run(id, async () => {
      try {
        await api(`/api/admin/category-banners/${id}`, { method: 'DELETE', auth: true, success: 'Banner deleted' });
        if (editing === id) setEditing(null);
        load();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      }
    });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Category banners</h1>
      <p className="mt-1 text-sm text-gray-500">
        The carousel at the top of a category&rsquo;s page. A category with no live banner shows none.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className={labelClass} htmlFor="banner-category">
          Category
        </label>
        <select
          id="banner-category"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setEditing(null);
          }}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none"
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {'— '.repeat(c.depth)}
              {c.name}
              {c.isActive ? '' : ' (inactive)'}
            </option>
          ))}
        </select>
        {category && (
          <a href={`/category/${category.slug}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-brand-600 hover:underline">
            View page ↗
          </a>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {editing === null ? (
        <button
          onClick={() => open('new')}
          disabled={!categoryId}
          className="mt-4 rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
        >
          + New banner
        </button>
      ) : (
        <form
          onSubmit={(e) => void submit(e)}
          className="mt-4 grid gap-3 rounded-2xl border border-gray-100 bg-white p-4 sm:grid-cols-2"
          data-category-banner-form
        >
          <p className="text-sm font-bold sm:col-span-2">
            {editing === 'new' ? 'New banner' : 'Edit banner'} for {category?.name}
          </p>
          <div className="sm:col-span-2">
            <BannerModeFields
              mode={form.imageMode}
              onMode={(imageMode) => setForm((f) => ({ ...f, imageMode }))}
              altText={form.altText}
              onAltText={(altText) => setForm((f) => ({ ...f, altText }))}
              altError={fieldErrors.altText}
              linkHint="the button link below, or the products"
            />
          </div>
          <div>
            <label className={labelClass}>Small line above (optional)</label>
            <input value={form.eyebrow} name="eyebrow" onChange={set('eyebrow')} placeholder="e.g. New season" className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.eyebrow} />
          </div>
          <div>
            <label className={labelClass}>
              Headline *{form.imageMode === 'FULL_IMAGE' && ' (names the banner here; not shown)'}
            </label>
            <input value={form.headline} name="headline" onChange={set('headline')} placeholder="e.g. Dress the" className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.headline} />
          </div>
          <div>
            <label className={labelClass}>Gold line under it (optional)</label>
            <input value={form.highlight} name="highlight" onChange={set('highlight')} placeholder="e.g. New You." className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.highlight} />
          </div>
          <div>
            <label className={labelClass}>Subtext</label>
            <input value={form.subtext} name="subtext" onChange={set('subtext')} className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.subtext} />
          </div>
          <div className="sm:col-span-2">
            <ImageUploadField
              label={form.imageMode === 'FULL_IMAGE' ? 'Banner image * (computer)' : 'Picture behind the text'}
              value={form.imageUrl}
              onChange={(imageUrl) => setForm((f) => ({ ...f, imageUrl }))}
              size={form.imageMode === 'FULL_IMAGE' ? IMAGE_SLOTS.CATEGORY_BANNER.full : IMAGE_SLOTS.CATEGORY_BANNER.picture}
              name="imageUrl"
              error={fieldErrors.imageUrl}
              note={form.imageMode === 'FULL_IMAGE' ? undefined : 'the right three-quarters show; keep the subject on the right'}
            />
          </div>
        <div className="sm:col-span-2">
          <ImageUploadField
            label="Phone image (optional)"
            value={form.mobileImageUrl}
            onChange={(mobileImageUrl) => setForm((f) => ({ ...f, mobileImageUrl }))}
            size={IMAGE_SLOTS.CATEGORY_BANNER.mobile}
            name="mobileImageUrl"
            error={fieldErrors.mobileImageUrl}
            note="shown on phones instead; without one, phones get the computer image"
          />
        </div>
          <div>
            <label className={labelClass}>Button label</label>
            <input value={form.primaryLabel} name="primaryLabel" onChange={set('primaryLabel')} className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.primaryLabel} />
          </div>
          <div>
            <label className={labelClass}>
              {form.imageMode === 'FULL_IMAGE' ? 'Where the banner leads' : 'Button link'} (blank: the products below)
            </label>
            <input value={form.primaryHref} name="primaryHref" onChange={set('primaryHref')} placeholder="#products" className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.primaryHref} />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <button
              disabled={busy || form.headline.trim().length < 3}
              aria-busy={busy}
              data-action="save-category-banner"
              className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Spinner className="mr-1" />
                  Saving…
                </>
              ) : editing === 'new' ? (
                'Create'
              ) : (
                'Save changes'
              )}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="text-sm text-gray-500 hover:underline">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mt-5 space-y-3">
        {categoryId && rows === null && <p className="text-sm text-gray-500">Loading…</p>}
        {rows && rows.length === 0 && <p className="text-sm text-gray-400">No banners for this category yet.</p>}
        {rows?.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-4 rounded-2xl border border-gray-100 bg-white p-4">
            {row.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={row.imageUrl} alt="" className="h-16 w-28 rounded-lg object-cover" />
            )}
            <div className="min-w-0 flex-1">
              {row.eyebrow && <p className="text-[11px] font-bold uppercase tracking-wide text-brand-600">{row.eyebrow}</p>}
              <p className="font-semibold">
                {row.imageMode === 'FULL_IMAGE' && (
                  <span className="mr-1 rounded bg-ink-900 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">Full image</span>
                )}
                {row.headline} {row.highlight && <span className="text-brand-600">{row.highlight}</span>}
              </p>
              <p className="break-words text-xs text-gray-500">
                {row.primaryLabel} → {row.primaryHref || 'the products below'}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs font-semibold">
              <button onClick={() => open(row)} className="text-brand-600 hover:underline">
                Edit
              </button>
              <button
                onClick={() => void patch(row.id, { isActive: !row.isActive })}
                disabled={isPending(row.id)}
                aria-busy={isPending(row.id)}
                className={`disabled:opacity-50 ${row.isActive ? 'text-gray-500 hover:underline' : 'text-green-600 hover:underline'}`}
              >
                {isPending(row.id) && <Spinner className="mr-1" />}
                {row.isActive ? 'Deactivate' : 'Activate'}
              </button>
              <button
                onClick={() => void remove(row.id)}
                disabled={isPending(row.id)}
                className="text-red-500 hover:underline disabled:opacity-50"
              >
                Delete
              </button>
              <span className={`rounded-full px-2 py-0.5 ${row.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                {row.isActive ? 'Live' : 'Off'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
