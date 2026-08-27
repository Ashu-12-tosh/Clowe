'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BUSINESS_TYPES,
  HIGHLIGHT_PRESETS,
  STORE_TABS,
  STORE_TAB_LABELS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  storeBusinessSchema,
  storeHoursSchema,
  storeProfileSchema,
  storeReturnsSchema,
  storeShippingSchema,
  type CategoryNode,
  type SellerStoreOverview,
  type SellerStoreSettings,
  type StoreHighlight,
  type StoreTab,
  type Weekday,
} from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';
import StorePreview from '@/components/seller/store/StorePreview';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

const TAB_ICONS: Record<StoreTab, string> = {
  PROFILE: '🏪',
  BUSINESS: '🧾',
  BANK: '🏦',
  SHIPPING: '🚚',
  RETURNS: '↩',
  HOURS: '🕐',
  INTEGRATIONS: '🔌',
};

function Section({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-ink-900">{title}</h2>
          {subtitle && <p className="text-[11px] text-gray-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-500">{label}</label>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

export default function SellerStoreSettingsPage() {
  const [tab, setTab] = useState<StoreTab>('PROFILE');
  const [data, setData] = useState<SellerStoreOverview | null>(null);
  const [form, setForm] = useState<SellerStoreSettings | null>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<'logo' | 'banner' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const body = await api<SellerStoreOverview>('/api/seller/store', { auth: true });
      setData(body);
      setForm(body.settings);
      setError('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load store settings');
    }
  }, []);

  useEffect(() => {
    void load();
    api<CategoryNode[]>('/api/categories')
      .then(setCategories)
      .catch(() => {});
  }, [load]);

  function patch(next: Partial<SellerStoreSettings>) {
    setForm((prev) => (prev ? { ...prev, ...next } : prev));
  }

  async function upload(kind: 'logo' | 'banner', files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(kind);
    setError('');
    try {
      const [url] = await uploadImages([files[0]]);
      patch(kind === 'logo' ? { logoUrl: url } : { bannerUrl: url });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  }

  /** Each tab saves only its own section, so one bad field can't block others. */
  async function save() {
    if (!form) return;
    setError('');
    setNotice('');

    const section: Record<string, { path: string; payload: unknown; schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } } }> = {
      PROFILE: {
        path: 'profile',
        schema: storeProfileSchema,
        payload: {
          shopName: form.shopName,
          slug: form.slug ?? '',
          tagline: form.tagline ?? '',
          description: form.description ?? '',
          logoUrl: form.logoUrl ?? '',
          bannerUrl: form.bannerUrl ?? '',
          storeEmail: form.storeEmail ?? '',
          storePhone: form.storePhone ?? '',
          primaryCategoryId: form.primaryCategoryId ?? '',
          highlights: form.highlights,
          socialLinks: form.socialLinks,
        },
      },
      BUSINESS: {
        path: 'business',
        schema: storeBusinessSchema,
        payload: {
          businessType: form.businessType ?? '',
          gstNumber: form.gstNumber ?? '',
          panNumber: form.panNumber ?? '',
          addressLine1: form.addressLine1 ?? '',
          addressLine2: form.addressLine2 ?? '',
          landmark: form.landmark ?? '',
          city: form.city ?? '',
          state: form.state ?? '',
          pincode: form.pincode ?? '',
        },
      },
      SHIPPING: {
        path: 'shipping',
        schema: storeShippingSchema,
        payload: {
          pickupSameAsBusiness: form.pickupSameAsBusiness,
          pickupName: form.pickupName ?? '',
          pickupPhone: form.pickupPhone ?? '',
          pickupLine1: form.pickupLine1 ?? '',
          pickupLine2: form.pickupLine2 ?? '',
          pickupCity: form.pickupCity ?? '',
          pickupState: form.pickupState ?? '',
          pickupPincode: form.pickupPincode ?? '',
          dispatchDays: form.dispatchDays,
          codEnabled: form.codEnabled,
        },
      },
      RETURNS: {
        path: 'returns',
        schema: storeReturnsSchema,
        payload: {
          returnWindowDays: form.returnWindowDays,
          returnAddressSameAsPickup: form.returnAddressSameAsPickup,
          returnLine1: form.returnLine1 ?? '',
          returnCity: form.returnCity ?? '',
          returnState: form.returnState ?? '',
          returnPincode: form.returnPincode ?? '',
        },
      },
      HOURS: {
        path: 'hours',
        schema: storeHoursSchema,
        payload: {
          workingHours: form.workingHours,
          vacationMode: form.vacationMode,
          vacationUntil: form.vacationUntil ?? '',
          vacationMessage: form.vacationMessage ?? '',
        },
      },
    };

    const target = section[tab];
    if (!target) return;

    const parsed = target.schema.safeParse(target.payload);
    if (!parsed.success) {
      setError(parsed.error?.issues[0].message ?? 'Please check the form');
      return;
    }

    setBusy(true);
    try {
      const body = await api<SellerStoreOverview>(`/api/seller/store/${target.path}`, {
        method: 'PUT',
        body: target.payload,
        auth: true,
      });
      setData(body);
      setForm(body.settings);
      setNotice('Saved.');
      setTimeout(() => setNotice(''), 2500);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  if (!form || !data) {
    return <p className="text-sm text-gray-500">{error || 'Loading…'}</p>;
  }

  const health = data.health;
  const savable = tab !== 'BANK' && tab !== 'INTEGRATIONS';

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Store Settings</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            How your shop looks to customers, and how it behaves when they buy.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {form.storeUrl ? (
            <a
              href={form.storeUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold hover:bg-gray-50"
            >
              👁 View store
            </a>
          ) : (
            <span
              title="Claim a store URL first"
              className="cursor-not-allowed rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-semibold opacity-50"
            >
              👁 View store
            </span>
          )}
          {savable && (
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">
          ✓ {notice}
        </p>
      )}
      {form.vacationMode && (
        <p className="mt-4 rounded-xl border border-yellow-300 bg-yellow-50 px-4 py-2.5 text-sm text-yellow-800">
          🌴 Vacation mode is on — your listings are hidden from the storefront until you switch it
          off.
        </p>
      )}

      {/* --- Tabs -------------------------------------------------------- */}
      <div className="mt-5 flex flex-wrap gap-1 rounded-2xl border border-gray-100 bg-white p-2">
        {STORE_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
              tab === t
                ? 'bg-ink-900 text-white'
                : 'text-gray-500 hover:bg-cream-100 hover:text-ink-900'
            }`}
          >
            <span>{TAB_ICONS[t]}</span>
            {STORE_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* --- Profile ------------------------------------------------- */}
          {tab === 'PROFILE' && (
            <>
              <Section title="Store profile" subtitle="Basic information customers see">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Store name *">
                    <input
                      value={form.shopName}
                      onChange={(e) => patch({ shopName: e.target.value })}
                      maxLength={60}
                      className={field}
                    />
                  </Field>
                  <Field
                    label="Store URL"
                    hint={form.slug ? `clowe.com/store/${form.slug}` : 'Claim your store link'}
                  >
                    <input
                      value={form.slug ?? ''}
                      onChange={(e) => patch({ slug: e.target.value.toLowerCase() })}
                      placeholder="your-store"
                      className={field}
                    />
                  </Field>
                  <Field label="Tagline" hint="One line under your store name">
                    <input
                      value={form.tagline ?? ''}
                      onChange={(e) => patch({ tagline: e.target.value })}
                      maxLength={80}
                      className={field}
                    />
                  </Field>
                  <Field label="Primary category">
                    <select
                      value={form.primaryCategoryId ?? ''}
                      onChange={(e) => patch({ primaryCategoryId: e.target.value })}
                      className={field}
                    >
                      <option value="">Not set</option>
                      {categories.map((root) => (
                        <optgroup key={root.id} label={root.name}>
                          <option value={root.id}>{root.name}</option>
                          {root.children.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </Field>
                  <div className="sm:col-span-2">
                    <Field
                      label="Store description"
                      hint={`${(form.description ?? '').length}/500 — what you sell and why shoppers should trust you`}
                    >
                      <textarea
                        value={form.description ?? ''}
                        onChange={(e) => patch({ description: e.target.value })}
                        rows={3}
                        maxLength={500}
                        className={field}
                      />
                    </Field>
                  </div>
                  <Field label="Store email">
                    <input
                      value={form.storeEmail ?? ''}
                      onChange={(e) => patch({ storeEmail: e.target.value })}
                      placeholder="support@yourstore.com"
                      className={field}
                    />
                  </Field>
                  <Field label="Store phone">
                    <input
                      value={form.storePhone ?? ''}
                      onChange={(e) => patch({ storePhone: e.target.value })}
                      placeholder="+91 98765 43210"
                      className={field}
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Logo & banner" subtitle="Logo 512×512, banner 1920×600">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold text-gray-500">Store logo</p>
                    <div className="mt-2 flex items-center gap-3">
                      <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink-900 text-lg font-bold text-white">
                        {form.logoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={form.logoUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          form.shopName.slice(0, 2).toUpperCase()
                        )}
                      </span>
                      <div className="space-y-1.5">
                        <label className="block cursor-pointer rounded-lg border border-gray-300 px-3 py-1.5 text-center text-xs font-semibold hover:bg-gray-50">
                          {uploading === 'logo' ? 'Uploading…' : 'Upload logo'}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              void upload('logo', e.target.files);
                              e.target.value = '';
                            }}
                          />
                        </label>
                        {form.logoUrl && (
                          <button
                            onClick={() => patch({ logoUrl: null })}
                            className="block w-full text-xs text-red-600 hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-500">Store banner</p>
                    <div className="mt-2">
                      <div className="h-20 overflow-hidden rounded-lg bg-cream-100">
                        {form.bannerUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={form.bannerUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full items-center justify-center text-[11px] text-gray-400">
                            No banner yet
                          </div>
                        )}
                      </div>
                      <div className="mt-1.5 flex gap-2">
                        <label className="flex-1 cursor-pointer rounded-lg border border-gray-300 px-3 py-1.5 text-center text-xs font-semibold hover:bg-gray-50">
                          {uploading === 'banner' ? 'Uploading…' : 'Upload banner'}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              void upload('banner', e.target.files);
                              e.target.value = '';
                            }}
                          />
                        </label>
                        {form.bannerUrl && (
                          <button
                            onClick={() => patch({ bannerUrl: null })}
                            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </Section>

              <Section
                title="Store highlights"
                subtitle="Trust chips shown on your store page (up to 6)"
              >
                <div className="flex flex-wrap gap-1.5">
                  {HIGHLIGHT_PRESETS.filter(
                    (h) => !form.highlights.some((x) => x.title === h.title),
                  ).map((h) => (
                    <button
                      key={h.title}
                      onClick={() =>
                        form.highlights.length < 6 &&
                        patch({ highlights: [...form.highlights, h] })
                      }
                      className="rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-cream-200"
                    >
                      ＋ {h.icon} {h.title}
                    </button>
                  ))}
                </div>
                <div className="mt-3 space-y-2">
                  {form.highlights.map((h, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        value={h.icon}
                        onChange={(e) =>
                          patch({
                            highlights: form.highlights.map((x, j) =>
                              i === j ? { ...x, icon: e.target.value } : x,
                            ) as StoreHighlight[],
                          })
                        }
                        className={`${field} w-14 text-center`}
                      />
                      <input
                        value={h.title}
                        onChange={(e) =>
                          patch({
                            highlights: form.highlights.map((x, j) =>
                              i === j ? { ...x, title: e.target.value } : x,
                            ) as StoreHighlight[],
                          })
                        }
                        className={`${field} max-w-40`}
                      />
                      <input
                        value={h.subtitle}
                        onChange={(e) =>
                          patch({
                            highlights: form.highlights.map((x, j) =>
                              i === j ? { ...x, subtitle: e.target.value } : x,
                            ) as StoreHighlight[],
                          })
                        }
                        className={field}
                      />
                      <button
                        onClick={() =>
                          patch({ highlights: form.highlights.filter((_, j) => j !== i) })
                        }
                        className="px-2 text-red-500"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {form.highlights.length === 0 && (
                    <p className="text-xs text-gray-400">None yet — add a few from the presets.</p>
                  )}
                </div>
              </Section>

              <Section title="Social links" subtitle="Shown on your store page">
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['website', 'instagram', 'facebook', 'youtube'] as const).map((key) => (
                    <Field key={key} label={key.charAt(0).toUpperCase() + key.slice(1)}>
                      <input
                        value={form.socialLinks[key]}
                        onChange={(e) =>
                          patch({ socialLinks: { ...form.socialLinks, [key]: e.target.value } })
                        }
                        placeholder={`https://${key === 'website' ? 'yourstore.com' : `${key}.com/yourstore`}`}
                        className={field}
                      />
                    </Field>
                  ))}
                </div>
              </Section>
            </>
          )}

          {/* --- Business ------------------------------------------------ */}
          {tab === 'BUSINESS' && (
            <Section
              title="Business information"
              subtitle="Used on your tax invoices and for KYC"
              action={
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    form.kycStatus === 'VERIFIED'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-yellow-100 text-yellow-700'
                  }`}
                >
                  KYC: {form.kycStatus.replace('_', ' ').toLowerCase()}
                </span>
              }
            >
              {form.kycStatus === 'VERIFIED' && (
                <p className="mb-3 rounded-lg bg-cream-50 px-3 py-2 text-[11px] text-gray-600">
                  GSTIN and PAN are locked now that your shop is verified. Raise a support ticket if
                  they need to change.
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Business type">
                  <select
                    value={form.businessType ?? ''}
                    onChange={(e) => patch({ businessType: e.target.value })}
                    className={field}
                  >
                    <option value="">Not set</option>
                    {BUSINESS_TYPES.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="GSTIN" hint="Format 29ABCDE1234F1Z5">
                  <input
                    value={form.gstNumber ?? ''}
                    onChange={(e) => patch({ gstNumber: e.target.value.toUpperCase() })}
                    disabled={form.kycStatus === 'VERIFIED'}
                    className={`${field} uppercase disabled:bg-gray-50`}
                  />
                </Field>
                <Field label="PAN" hint="Format ABCDE1234F">
                  <input
                    value={form.panNumber ?? ''}
                    onChange={(e) => patch({ panNumber: e.target.value.toUpperCase() })}
                    disabled={form.kycStatus === 'VERIFIED'}
                    className={`${field} uppercase disabled:bg-gray-50`}
                  />
                </Field>
                <Field label="Address line 1">
                  <input
                    value={form.addressLine1 ?? ''}
                    onChange={(e) => patch({ addressLine1: e.target.value })}
                    className={field}
                  />
                </Field>
                <Field label="Address line 2">
                  <input
                    value={form.addressLine2 ?? ''}
                    onChange={(e) => patch({ addressLine2: e.target.value })}
                    className={field}
                  />
                </Field>
                <Field label="Landmark">
                  <input
                    value={form.landmark ?? ''}
                    onChange={(e) => patch({ landmark: e.target.value })}
                    className={field}
                  />
                </Field>
                <Field label="City">
                  <input
                    value={form.city ?? ''}
                    onChange={(e) => patch({ city: e.target.value })}
                    className={field}
                  />
                </Field>
                <Field label="State">
                  <input
                    value={form.state ?? ''}
                    onChange={(e) => patch({ state: e.target.value })}
                    className={field}
                  />
                </Field>
                <Field label="PIN code">
                  <input
                    value={form.pincode ?? ''}
                    onChange={(e) => patch({ pincode: e.target.value })}
                    className={field}
                  />
                </Field>
              </div>
            </Section>
          )}

          {/* --- Bank ---------------------------------------------------- */}
          {tab === 'BANK' && (
            <Section
              title="Bank & payouts"
              subtitle="Payout methods live on the Payouts page, where they are verified"
            >
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Account holder</dt>
                  <dd className="text-ink-900">{form.bankAccountName ?? '— not set'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Account number</dt>
                  <dd className="text-ink-900">
                    {form.bankAccountLast4 ? `•••• ${form.bankAccountLast4}` : '— not set'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">IFSC</dt>
                  <dd className="text-ink-900">{form.bankIfsc ?? '— not set'}</dd>
                </div>
                <div className="flex justify-between border-t border-gray-100 pt-2">
                  <dt className="text-gray-500">Verified payout methods</dt>
                  <dd className="font-semibold text-ink-900">{form.payoutMethodCount}</dd>
                </div>
              </dl>
              <Link
                href="/seller/payouts"
                className="mt-3 inline-block rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
              >
                Manage payout methods →
              </Link>
              <p className="mt-2 text-[11px] text-gray-400">
                Money only moves to a verified method. Full account numbers are never stored here.
              </p>
            </Section>
          )}

          {/* --- Shipping ------------------------------------------------ */}
          {tab === 'SHIPPING' && (
            <>
              <Section title="Pickup address" subtitle="Couriers collect here, and it prints on your labels">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.pickupSameAsBusiness}
                    onChange={(e) => patch({ pickupSameAsBusiness: e.target.checked })}
                    className="h-4 w-4 accent-[#B8860B]"
                  />
                  Same as my business address
                </label>
                {!form.pickupSameAsBusiness && (
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <Field label="Contact name">
                      <input
                        value={form.pickupName ?? ''}
                        onChange={(e) => patch({ pickupName: e.target.value })}
                        className={field}
                      />
                    </Field>
                    <Field label="Contact phone">
                      <input
                        value={form.pickupPhone ?? ''}
                        onChange={(e) => patch({ pickupPhone: e.target.value })}
                        className={field}
                      />
                    </Field>
                    <Field label="Address line 1 *">
                      <input
                        value={form.pickupLine1 ?? ''}
                        onChange={(e) => patch({ pickupLine1: e.target.value })}
                        className={field}
                      />
                    </Field>
                    <Field label="Address line 2">
                      <input
                        value={form.pickupLine2 ?? ''}
                        onChange={(e) => patch({ pickupLine2: e.target.value })}
                        className={field}
                      />
                    </Field>
                    <Field label="City">
                      <input
                        value={form.pickupCity ?? ''}
                        onChange={(e) => patch({ pickupCity: e.target.value })}
                        className={field}
                      />
                    </Field>
                    <Field label="State">
                      <input
                        value={form.pickupState ?? ''}
                        onChange={(e) => patch({ pickupState: e.target.value })}
                        className={field}
                      />
                    </Field>
                    <Field label="PIN code *">
                      <input
                        value={form.pickupPincode ?? ''}
                        onChange={(e) => patch({ pickupPincode: e.target.value })}
                        className={field}
                      />
                    </Field>
                  </div>
                )}
              </Section>

              <Section title="Fulfilment preferences">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Dispatch promise (working days)"
                    hint="Shipping later than this counts against your account health"
                  >
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={form.dispatchDays}
                      onChange={(e) => patch({ dispatchDays: Number(e.target.value) || 1 })}
                      className={field}
                    />
                  </Field>
                  <div className="flex items-end">
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.codEnabled}
                        onChange={(e) => patch({ codEnabled: e.target.checked })}
                        className="mt-0.5 h-4 w-4 accent-[#B8860B]"
                      />
                      <span>
                        Accept Cash on Delivery
                        <span className="block text-[11px] text-gray-400">
                          Unticking it blocks COD checkout for carts containing your items.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
                <p className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-[11px] text-gray-600">
                  Shipping charges and free-shipping thresholds are set by the marketplace, not per
                  shop, so they are the same for every seller.
                </p>
              </Section>
            </>
          )}

          {/* --- Returns ------------------------------------------------- */}
          {tab === 'RETURNS' && (
            <Section title="Return policy" subtitle="You may be more generous than the marketplace, never stricter">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Return window (days)"
                  hint={`Marketplace minimum is ${form.platformReturnWindowDays} days. Leave blank to follow it.`}
                >
                  <input
                    type="number"
                    min={form.platformReturnWindowDays}
                    max={30}
                    value={form.returnWindowDays ?? ''}
                    onChange={(e) =>
                      patch({
                        returnWindowDays: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    placeholder={`${form.platformReturnWindowDays} (platform default)`}
                    className={field}
                  />
                </Field>
                <Field label="In force now">
                  <p className="rounded-lg bg-cream-50 px-3 py-2 text-sm font-semibold text-ink-900">
                    {form.effectiveReturnWindowDays} days from delivery
                  </p>
                </Field>
              </div>

              <label className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.returnAddressSameAsPickup}
                  onChange={(e) => patch({ returnAddressSameAsPickup: e.target.checked })}
                  className="h-4 w-4 accent-[#B8860B]"
                />
                Returns come back to my pickup address
              </label>
              {!form.returnAddressSameAsPickup && (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Return address line 1">
                    <input
                      value={form.returnLine1 ?? ''}
                      onChange={(e) => patch({ returnLine1: e.target.value })}
                      className={field}
                    />
                  </Field>
                  <Field label="City">
                    <input
                      value={form.returnCity ?? ''}
                      onChange={(e) => patch({ returnCity: e.target.value })}
                      className={field}
                    />
                  </Field>
                  <Field label="State">
                    <input
                      value={form.returnState ?? ''}
                      onChange={(e) => patch({ returnState: e.target.value })}
                      className={field}
                    />
                  </Field>
                  <Field label="PIN code">
                    <input
                      value={form.returnPincode ?? ''}
                      onChange={(e) => patch({ returnPincode: e.target.value })}
                      className={field}
                    />
                  </Field>
                </div>
              )}
              <p className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-[11px] text-gray-600">
                Return pickup is arranged and paid for by the marketplace. Decide on requests within
                48 hours — see the Returns page.
              </p>
            </Section>
          )}

          {/* --- Hours --------------------------------------------------- */}
          {tab === 'HOURS' && (
            <>
              <Section title="Working hours" subtitle="Shown on your store page so shoppers know when you reply">
                <div className="space-y-2">
                  {WEEKDAYS.map((day) => {
                    const h = form.workingHours[day];
                    return (
                      <div key={day} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="w-24 text-gray-600">{WEEKDAY_LABELS[day]}</span>
                        <input
                          type="time"
                          value={h.open}
                          disabled={h.closed}
                          onChange={(e) =>
                            patch({
                              workingHours: {
                                ...form.workingHours,
                                [day]: { ...h, open: e.target.value },
                              } as Record<Weekday, typeof h>,
                            })
                          }
                          className="rounded-lg border border-gray-300 px-2 py-1 text-xs outline-none disabled:bg-gray-50"
                        />
                        <span className="text-xs text-gray-400">to</span>
                        <input
                          type="time"
                          value={h.close}
                          disabled={h.closed}
                          onChange={(e) =>
                            patch({
                              workingHours: {
                                ...form.workingHours,
                                [day]: { ...h, close: e.target.value },
                              } as Record<Weekday, typeof h>,
                            })
                          }
                          className="rounded-lg border border-gray-300 px-2 py-1 text-xs outline-none disabled:bg-gray-50"
                        />
                        <label className="flex items-center gap-1.5 text-xs text-gray-500">
                          <input
                            type="checkbox"
                            checked={h.closed}
                            onChange={(e) =>
                              patch({
                                workingHours: {
                                  ...form.workingHours,
                                  [day]: { ...h, closed: e.target.checked },
                                } as Record<Weekday, typeof h>,
                              })
                            }
                            className="h-3.5 w-3.5 accent-[#B8860B]"
                          />
                          Closed
                        </label>
                      </div>
                    );
                  })}
                </div>
              </Section>

              <Section
                title="Vacation mode"
                subtitle="Pause the shop without archiving anything"
              >
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.vacationMode}
                    onChange={(e) => patch({ vacationMode: e.target.checked })}
                    className="mt-0.5 h-4 w-4 accent-[#B8860B]"
                  />
                  <span>
                    Turn on vacation mode
                    <span className="block text-[11px] text-gray-400">
                      Your listings disappear from browsing, search and product pages until you
                      switch it off. Existing orders still need to be fulfilled.
                    </span>
                  </span>
                </label>
                {form.vacationMode && (
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <Field label="Back on (optional)">
                      <input
                        type="date"
                        value={form.vacationUntil ? form.vacationUntil.slice(0, 10) : ''}
                        onChange={(e) => patch({ vacationUntil: e.target.value })}
                        className={field}
                      />
                    </Field>
                    <Field label="Message for shoppers">
                      <input
                        value={form.vacationMessage ?? ''}
                        onChange={(e) => patch({ vacationMessage: e.target.value })}
                        placeholder="Back on 20 August — thanks for your patience!"
                        className={field}
                      />
                    </Field>
                  </div>
                )}
              </Section>
            </>
          )}

          {/* --- Integrations -------------------------------------------- */}
          {tab === 'INTEGRATIONS' && (
            <Section
              title="Platform integrations"
              subtitle="Services Clowe runs on your behalf — nothing to connect per shop"
            >
              <ul className="divide-y divide-gray-50">
                {data.integrations.map((i) => (
                  <li key={i.key} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink-900">
                        {i.purpose}
                        <span className="ml-1.5 font-mono text-[11px] font-normal text-gray-400">
                          {i.name}
                        </span>
                      </p>
                      <p className="text-[11px] text-gray-500">{i.detail}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        i.status === 'LIVE'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-yellow-100 text-yellow-700'
                      }`}
                    >
                      {i.status === 'LIVE' ? 'Live' : 'Sandbox'}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {/* --- Sidebar --------------------------------------------------- */}
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">
              Store preview
            </p>
            <StorePreview s={form} />
            {form.storeUrl && (
              <a
                href={form.storeUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block text-center text-[11px] font-semibold text-brand-600 hover:underline"
              >
                Open the live store page →
              </a>
            )}
          </div>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center gap-3">
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(#B8860B ${health.score * 3.6}deg, #F1EFEA 0deg)`,
                }}
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-xs font-bold text-ink-900">
                  {health.score}%
                </span>
              </div>
              <div>
                <h2 className="text-sm font-bold text-ink-900">Store strength</h2>
                <p className="text-[11px] text-gray-500">
                  {health.rating === 'EXCELLENT'
                    ? 'Excellent — your store is fully set up.'
                    : health.rating === 'GOOD'
                      ? 'Good — a few things left.'
                      : 'Finish the basics to build trust.'}
                </p>
              </div>
            </div>
            <ul className="mt-3 space-y-1.5 text-xs">
              {health.items.map((item) => (
                <li key={item.key}>
                  <button
                    onClick={() => setTab(item.tab)}
                    className="flex w-full items-start gap-2 text-left hover:text-brand-600"
                    title={item.done ? undefined : item.hint}
                  >
                    <span className={item.done ? 'text-green-600' : 'text-gray-300'}>
                      {item.done ? '✓' : '○'}
                    </span>
                    <span className={item.done ? 'text-ink-900' : 'text-gray-500'}>
                      {item.label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Quick links</h2>
            <ul className="mt-2 space-y-1 text-xs">
              {[
                { href: '/seller/payouts', label: 'Payout methods & statements' },
                { href: '/seller/returns', label: 'Return requests' },
                { href: '/seller/products', label: 'Your products' },
                { href: '/seller/support', label: 'Support & account health' },
              ].map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="block rounded-lg px-2 py-1.5 text-gray-600 hover:bg-cream-50 hover:text-ink-900"
                  >
                    {l.label} →
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
