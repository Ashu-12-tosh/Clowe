'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  IMAGE_SLOTS,
  bannerImageProblem,
  promoTileUpsertSchema,
  type AdminPromoTileRow,
  type BannerImageModeValue,
  type PromoPlacementValue,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import { issuesToFieldErrors, useFieldErrors } from '@/lib/fieldErrors';
import { toast } from '@/lib/toast';
import { usePending } from '@/lib/usePending';
import FieldError from '@/components/FieldError';
import Spinner from '@/components/Spinner';
import ImageUploadField from '@/components/admin/ImageUploadField';
import BannerModeFields from '@/components/admin/BannerModeFields';
import BannerPreview from '@/components/admin/BannerPreview';
import FocalPointPicker from '@/components/admin/FocalPointPicker';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';
const labelClass = 'text-xs font-semibold text-gray-700';

const EMPTY = {
  placement: 'PROMO_CARD' as PromoPlacementValue,
  title: '',
  subtitle: '',
  href: '/products',
  imageUrl: '',
  imageMode: 'DESIGNED' as BannerImageModeValue,
  altText: '',
  mobileImageUrl: '',
  focalX: 50,
  focalY: 50,
};
type Form = typeof EMPTY;

const slotOf = (placement: PromoPlacementValue) =>
  placement === 'PROMO_CARD' ? IMAGE_SLOTS.PROMO_CARD : IMAGE_SLOTS.PROMO_STRIP;

export default function AdminPromosPage() {
  const [rows, setRows] = useState<AdminPromoTileRow[] | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  // null: adding a new tile; otherwise the tile being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { run, isPending } = usePending();
  const { errors: fieldErrors, show: showFieldErrors, fromError } = useFieldErrors();

  const load = useCallback(() => {
    api<AdminPromoTileRow[]>('/api/admin/promos', { auth: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function edit(row: AdminPromoTileRow) {
    setEditing(row.id);
    setForm({
      placement: row.placement,
      title: row.title,
      subtitle: row.subtitle ?? '',
      href: row.href,
      imageUrl: row.imageUrl ?? '',
      imageMode: row.imageMode,
      altText: row.altText ?? '',
      mobileImageUrl: row.mobileImageUrl ?? '',
      focalX: row.focalX ?? 50,
      focalY: row.focalY ?? 50,
    });
    showFieldErrors({});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reset() {
    setEditing(null);
    setForm(EMPTY);
    showFieldErrors({});
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    const body = {
      placement: form.placement,
      title: form.title.trim(),
      subtitle: form.subtitle.trim() || null,
      href: form.href.trim() || '/products',
      imageUrl: form.imageUrl.trim() || null,
      imageMode: form.imageMode,
      altText: form.altText.trim() || null,
      mobileImageUrl: form.mobileImageUrl.trim() || null,
      focalX: form.focalX,
      focalY: form.focalY,
      ...(editing ? {} : { sortOrder: rows?.filter((r) => r.placement === form.placement).length ?? 0 }),
    };
    const checked = promoTileUpsertSchema.safeParse(body);
    const problems = checked.success ? {} : issuesToFieldErrors(checked.error.issues);
    const image = bannerImageProblem(body);
    if (image && !problems[image.field]) problems[image.field] = image.message;
    if (showFieldErrors(problems)) {
      toast.error('Not saved: fix the fields marked in red');
      return;
    }
    setBusy(true);
    try {
      await api(editing ? `/api/admin/promos/${editing}` : '/api/admin/promos', {
        method: editing ? 'PATCH' : 'POST',
        body,
        auth: true,
        success: editing ? 'Promo tile saved — on the home page within a minute' : 'Promo tile added — on the home page within a minute',
      });
      reset();
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
        await api(`/api/admin/promos/${id}`, {
          method: 'PATCH',
          body,
          auth: true,
          success: 'isActive' in body ? `Promo tile ${body.isActive ? 'activated' : 'deactivated'}` : 'Promo tile saved',
        });
        load();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      }
    });
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this promo tile?')) return;
    await run(id, async () => {
      try {
        await api(`/api/admin/promos/${id}`, { method: 'DELETE', auth: true, success: 'Promo tile deleted' });
        if (editing === id) reset();
        load();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      }
    });
  }

  function Group({ kind, label }: { kind: PromoPlacementValue; label: string }) {
    const tiles = rows?.filter((r) => r.placement === kind) ?? [];
    return (
      <div className="mt-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-700">{label}</h2>
        <div className="mt-2 space-y-2">
          {tiles.length === 0 && <p className="text-sm text-gray-400">None yet.</p>}
          {tiles.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center gap-4 rounded-2xl border border-gray-100 bg-white p-3">
              {row.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={row.imageUrl} alt="" className="h-12 w-20 rounded-lg object-cover" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {row.imageMode === 'FULL_IMAGE' && (
                    <span className="mr-1 rounded bg-ink-900 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">Full image</span>
                  )}
                  {row.title} {row.subtitle && <span className="text-brand-600">· {row.subtitle}</span>}
                </p>
                <p className="break-words text-xs text-gray-500">→ {row.href}</p>
              </div>
              <div className="flex items-center gap-3 text-xs font-semibold">
                <button onClick={() => edit(row)} className="text-brand-600 hover:underline">
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

  const slot = slotOf(form.placement);
  return (
    <div>
      <h1 className="text-2xl font-bold">Promo tiles</h1>
      <p className="mt-1 text-sm text-gray-500">
        Cards = the 4-tile row near the top of the landing page. Strips = the 3 wide banners lower
        down.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <form
        onSubmit={(e) => void submit(e)}
        className="mt-4 grid gap-3 rounded-2xl border border-gray-100 bg-white p-4 sm:grid-cols-2"
        data-promo-form
      >
        <p className="text-sm font-bold sm:col-span-2">{editing ? 'Edit promo tile' : 'Add a promo tile'}</p>
        <div>
          <label className={labelClass}>Where</label>
          <select value={form.placement} name="placement" onChange={set('placement')} className={`mt-1 ${field} bg-white`}>
            <option value="PROMO_CARD">Card (top row)</option>
            <option value="PROMO_STRIP">Strip (wide)</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Title *</label>
          <input value={form.title} name="title" onChange={set('title')} placeholder="e.g. Summer Styles" className={`mt-1 ${field}`} />
          <FieldError message={fieldErrors.title} />
        </div>
        <div>
          <label className={labelClass}>Discount line</label>
          <input value={form.subtitle} name="subtitle" onChange={set('subtitle')} placeholder="e.g. Up to 60% off" className={`mt-1 ${field}`} />
          <FieldError message={fieldErrors.subtitle} />
        </div>
        <div>
          <label className={labelClass}>Link</label>
          <input value={form.href} name="href" onChange={set('href')} className={`mt-1 ${field}`} />
          <FieldError message={fieldErrors.href} />
        </div>
        <div className="sm:col-span-2">
          <BannerModeFields
            mode={form.imageMode}
            onMode={(imageMode) => setForm((f) => ({ ...f, imageMode }))}
            altText={form.altText}
            onAltText={(altText) => setForm((f) => ({ ...f, altText }))}
            altError={fieldErrors.altText}
            linkHint="the link above"
          />
        </div>
        <div className="sm:col-span-2">
          <ImageUploadField
            label={form.imageMode === 'FULL_IMAGE' ? 'Tile image * (the whole tile)' : 'Background picture'}
            value={form.imageUrl}
            onChange={(imageUrl) => setForm((f) => ({ ...f, imageUrl }))}
            size={form.imageMode === 'FULL_IMAGE' ? slot.full : slot.picture}
            name="imageUrl"
            error={fieldErrors.imageUrl}
          />
        </div>
        <div className="sm:col-span-2">
          <ImageUploadField
            label="Phone image (optional)"
            value={form.mobileImageUrl}
            onChange={(mobileImageUrl) => setForm((f) => ({ ...f, mobileImageUrl }))}
            size={slot.mobile}
            name="mobileImageUrl"
            error={fieldErrors.mobileImageUrl}
            note="shown on phones instead; without one, phones get the computer image"
          />
        </div>
        <div className="sm:col-span-2">
          {form.imageUrl.trim() && (
            <div className="mb-3">
              <FocalPointPicker imageUrl={form.imageUrl.trim()} mobileImageUrl={form.mobileImageUrl.trim()} x={form.focalX} y={form.focalY} onChange={(focalX, focalY) => setForm((f) => ({ ...f, focalX, focalY }))} />
            </div>
          )}
          <BannerPreview
            kind={form.placement}
            tile={{
              id: 'preview',
              title: form.title.trim() || 'Your title',
              subtitle: form.subtitle.trim() || null,
              imageUrl: form.imageUrl.trim() || null,
              href: form.href.trim() || '/products',
              imageMode: form.imageMode,
              altText: form.altText.trim() || null,
              mobileImageUrl: form.mobileImageUrl.trim() || null,
              focalX: form.focalX,
              focalY: form.focalY,
            }}
          />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <button
            disabled={busy || form.title.trim().length < 2}
            aria-busy={busy}
            data-action="save-promo"
            className="rounded-lg bg-ink-900 px-5 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? (
              <>
                <Spinner className="mr-1" />
                Saving…
              </>
            ) : editing ? (
              'Save changes'
            ) : (
              'Add'
            )}
          </button>
          {editing && (
            <button type="button" onClick={reset} className="text-sm text-gray-500 hover:underline">
              Cancel
            </button>
          )}
        </div>
      </form>

      <Group kind="PROMO_CARD" label="Promo cards (4-tile row)" />
      <Group kind="PROMO_STRIP" label="Promo strips (wide banners)" />
    </div>
  );
}
