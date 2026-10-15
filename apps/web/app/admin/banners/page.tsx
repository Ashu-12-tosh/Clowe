'use client';

import { useCallback, useEffect, useState } from 'react';
import { IMAGE_SLOTS, bannerUpsertSchema, type AdminBannerRow } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { issuesToFieldErrors, useFieldErrors } from '@/lib/fieldErrors';
import { toast } from '@/lib/toast';
import { usePending } from '@/lib/usePending';
import FieldError from '@/components/FieldError';
import Spinner from '@/components/Spinner';
import ImageUploadField from '@/components/admin/ImageUploadField';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';
const labelClass = 'text-xs font-semibold text-gray-700';

const EMPTY = {
  headline: '',
  highlight: '',
  subtext: '',
  imageUrl: '',
  primaryLabel: 'Shop Now',
  primaryHref: '/products',
  secondaryLabel: '',
  secondaryHref: '',
};
type Form = typeof EMPTY;

function formOf(row: AdminBannerRow): Form {
  return {
    headline: row.headline,
    highlight: row.highlight ?? '',
    subtext: row.subtext ?? '',
    imageUrl: row.imageUrl ?? '',
    primaryLabel: row.primaryLabel,
    primaryHref: row.primaryHref,
    secondaryLabel: row.secondaryLabel ?? '',
    secondaryHref: row.secondaryHref ?? '',
  };
}

export default function AdminBannersPage() {
  const [rows, setRows] = useState<AdminBannerRow[] | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  // null: no form open; 'new': creating; otherwise the banner being edited.
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { run, isPending } = usePending();
  const { errors: fieldErrors, show: showFieldErrors, fromError } = useFieldErrors();

  const load = useCallback(() => {
    api<AdminBannerRow[]>('/api/admin/banners', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function open(target: AdminBannerRow | 'new') {
    setForm(target === 'new' ? EMPTY : formOf(target));
    setEditing(target === 'new' ? 'new' : target.id);
    showFieldErrors({});
    setError('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !editing) return;
    setError('');
    const body = {
      headline: form.headline.trim(),
      highlight: form.highlight.trim() || null,
      subtext: form.subtext.trim() || null,
      imageUrl: form.imageUrl.trim() || null,
      primaryLabel: form.primaryLabel.trim() || 'Shop Now',
      primaryHref: form.primaryHref.trim() || '/products',
      secondaryLabel: form.secondaryLabel.trim() || null,
      secondaryHref: form.secondaryHref.trim() || null,
      ...(editing === 'new' ? { sortOrder: rows?.length ?? 0 } : {}),
    };
    const checked = bannerUpsertSchema.safeParse(body);
    if (showFieldErrors(checked.success ? {} : issuesToFieldErrors(checked.error.issues))) {
      toast.error('Not saved: fix the fields marked in red');
      return;
    }
    setBusy(true);
    try {
      await api(editing === 'new' ? '/api/admin/banners' : `/api/admin/banners/${editing}`, {
        method: editing === 'new' ? 'POST' : 'PATCH',
        body,
        auth: true,
        success: editing === 'new' ? 'Banner created — on the home page within a minute' : 'Banner saved — on the home page within a minute',
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
    setError('');
    await run(id, async () => {
      try {
        await api(`/api/admin/banners/${id}`, {
          method: 'PATCH',
          body,
          auth: true,
          success: 'isActive' in body ? `Banner ${body.isActive ? 'activated' : 'deactivated'}` : 'Banner saved',
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
        await api(`/api/admin/banners/${id}`, { method: 'DELETE', auth: true, success: 'Banner deleted' });
        if (editing === id) setEditing(null);
        load();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      }
    });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Hero banners</h1>
      <p className="mt-1 text-sm text-gray-500">
        Slides in the landing-page carousel. The &ldquo;highlight&rdquo; word inside the headline is
        rendered in gold. Changes appear on the homepage within a minute (cached).
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {editing === null ? (
        <button
          onClick={() => open('new')}
          className="mt-4 rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800"
        >
          + New banner
        </button>
      ) : (
        <form
          onSubmit={(e) => void submit(e)}
          className="mt-4 grid gap-3 rounded-2xl border border-gray-100 bg-white p-4 sm:grid-cols-2"
          data-banner-form
        >
          <p className="text-sm font-bold sm:col-span-2">{editing === 'new' ? 'New banner' : 'Edit banner'}</p>
          <div className="sm:col-span-2">
            <label className={labelClass}>Headline *</label>
            <input value={form.headline} name="headline" onChange={set('headline')} placeholder="e.g. Shop Everything. Smarter with AI." className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.headline} />
          </div>
          <div>
            <label className={labelClass}>Gold word (inside the headline)</label>
            <input value={form.highlight} name="highlight" onChange={set('highlight')} placeholder='e.g. "AI."' className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.highlight} />
          </div>
          <div>
            <label className={labelClass}>Subtext</label>
            <input value={form.subtext} name="subtext" onChange={set('subtext')} placeholder="One line under the headline" className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.subtext} />
          </div>
          <div className="sm:col-span-2">
            <ImageUploadField
              label="Picture beside the text"
              value={form.imageUrl}
              onChange={(imageUrl) => setForm((f) => ({ ...f, imageUrl }))}
              size={IMAGE_SLOTS.HOME_HERO.picture}
              name="imageUrl"
              error={fieldErrors.imageUrl}
            />
          </div>
          <div>
            <label className={labelClass}>Button label</label>
            <input value={form.primaryLabel} name="primaryLabel" onChange={set('primaryLabel')} className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.primaryLabel} />
          </div>
          <div>
            <label className={labelClass}>Button link</label>
            <input value={form.primaryHref} name="primaryHref" onChange={set('primaryHref')} placeholder="/products?category=fashion" className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.primaryHref} />
          </div>
          <div>
            <label className={labelClass}>Second button label (optional)</label>
            <input value={form.secondaryLabel} name="secondaryLabel" onChange={set('secondaryLabel')} className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.secondaryLabel} />
          </div>
          <div>
            <label className={labelClass}>Second button link</label>
            <input value={form.secondaryHref} name="secondaryHref" onChange={set('secondaryHref')} className={`mt-1 ${field}`} />
            <FieldError message={fieldErrors.secondaryHref} />
          </div>
          <div className="flex min-w-0 gap-2 sm:col-span-2">
            <button
              disabled={busy || form.headline.trim().length < 3}
              aria-busy={busy}
              data-action="save-banner"
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
        {rows === null && <p className="text-sm text-gray-500">Loading…</p>}
        {rows?.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-4 rounded-2xl border border-gray-100 bg-white p-4">
            {row.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={row.imageUrl} alt="" className="h-16 w-24 rounded-lg object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {row.headline}{' '}
                {row.highlight && <span className="text-xs text-brand-600">(gold: {row.highlight})</span>}
              </p>
              <p className="break-words text-xs text-gray-500">
                {row.primaryLabel} → {row.primaryHref}
                {row.secondaryLabel && ` · ${row.secondaryLabel} → ${row.secondaryHref}`}
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
