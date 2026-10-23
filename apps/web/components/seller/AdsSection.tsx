'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AD_PACKAGES,
  CPC_AD_TYPE_LABELS,
  CPC_AD_TYPES,
  PLACEMENT_KINDS,
  PLACEMENT_LABELS,
  PLACEMENT_SPACE,
  type AdCampaignRow,
  type AdMetrics,
  type AdsOverview,
  type CommercialSettings,
  type CpcAdType,
  type LegalEntity,
  type PlacementKind,
  type SellerPlanView,
  type SlotAvailability,
} from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { getPublicSettings } from '@/lib/settings';

// ---------------------------------------------------------------------------
// The seller's Advertising and Sponsorship sections (owner's Batch 2): one
// wallet, one calendar, one approval queue, one set of metrics. Every price
// here is before GST; 18% GST is added when it is charged.
// ---------------------------------------------------------------------------

interface AdsConfig {
  ads: CommercialSettings['ads'];
  sponsorship: CommercialSettings['sponsorship'];
  products: { id: string; title: string; categoryId: string }[];
  categories: { id: string; name: string }[];
}

type Section = 'advertising' | 'sponsorship';

const STATUS_STYLE: Record<AdCampaignRow['status'], string> = {
  PENDING_APPROVAL: 'bg-orange-100 text-orange-700',
  ACTIVE: 'bg-green-100 text-green-700',
  PAUSED: 'bg-gray-100 text-gray-700',
  ENDED: 'bg-gray-100 text-gray-500',
  REJECTED: 'bg-red-100 text-red-700',
};
const STATUS_LABEL: Record<AdCampaignRow['status'], string> = {
  PENDING_APPROVAL: 'Waiting for approval',
  ACTIVE: 'Running',
  PAUSED: 'Paused',
  ENDED: 'Ended',
  REJECTED: 'Not approved',
};
const PACKAGE_LABEL: Record<(typeof AD_PACKAGES)[number], string> = {
  STARTER: 'Starter',
  GROWTH: 'Growth',
  PREMIUM: 'Premium',
  LUXURY: 'Luxury',
  ENTERPRISE: 'Enterprise',
};
const rupees = (paise: number) => formatPaise(paise);
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const errText = (e: unknown) => (e instanceof ApiRequestError ? e.message : 'Something went wrong — try again.');

function MetricsGrid({ m }: { m: AdMetrics }) {
  const cells: [string, string][] = [
    ['Impressions', m.impressions.toLocaleString('en-IN')],
    ['Clicks', m.clicks.toLocaleString('en-IN')],
    ['CTR', `${m.ctr}%`],
    ['Avg. CPC', rupees(m.avgCpcPaise)],
    ['Orders (7 days)', m.orders.toLocaleString('en-IN')],
    ['Spend', rupees(m.spendPaise)],
    ['ROAS', m.spendPaise ? `${m.roas}×` : '—'],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {cells.map(([k, v]) => (
        <div key={k} className="rounded-xl bg-cream-50 p-3">
          <dt className="text-[11px] text-gray-500">{k}</dt>
          <dd className="mt-0.5 font-display text-lg font-bold text-ink-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink-900">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
}
const inputCls = 'mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm';

/** Contact vendor support (Enterprise packages, more credit): chat or email — no phone on the website. */
export function ContactVendorSupport({ topic }: { topic: string }) {
  const [legal, setLegal] = useState<LegalEntity | null>(null);
  useEffect(() => {
    getPublicSettings().then((s) => setLegal({ ...s.legalEntity, supportEmail: s.supportEmails?.vendor || s.legalEntity.supportEmail }) /* seller help: vendor-support@ */).catch(() => {});
  }, []);
  const text = encodeURIComponent(`Clowe vendor support — ${topic}`);
  return (
    <div className="flex flex-wrap gap-2" data-contact-support>
      <Link href="/seller/support" className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-ink-900 hover:bg-gray-50">
        Chat with vendor support
      </Link>
      {legal?.supportEmail && (
        <a href={`mailto:${legal.supportEmail}?subject=${text}`} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-ink-900 hover:bg-gray-50">
          {legal.supportEmail}
        </a>
      )}
    </div>
  );
}

function Availability({ placement, categoryId, from }: { placement: PlacementKind; categoryId?: string; from: string }) {
  const [a, setA] = useState<SlotAvailability | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams({ placement, from, days: '28' });
    if (categoryId) qs.set('categoryId', categoryId);
    api<SlotAvailability>(`/api/seller/advertising/availability?${qs}`, { auth: true }).then(setA).catch(() => setA(null));
  }, [placement, categoryId, from]);
  if (!a) return null;
  return (
    <div className="mt-2" data-availability>
      <p className="text-[11px] text-gray-500">Next 4 weeks — green has room, grey is booked:</p>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {a.days.map((d) => (
          <span
            key={d.date}
            title={`${d.date}: ${d.free} of ${d.slots} free`}
            className={`rounded px-1 py-0.5 text-center text-[10px] ${d.free > 0 ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-500 line-through'}`}
          >
            {d.date.slice(8)}/{d.date.slice(5, 7)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function AdsSection({ section }: { section: Section }) {
  const sponsorship = section === 'sponsorship';
  const [config, setConfig] = useState<AdsConfig | null>(null);
  const [overview, setOverview] = useState<AdsOverview | null>(null);
  const [plan, setPlan] = useState<SellerPlanView | null>(null);
  const [tab, setTab] = useState<'cpc' | 'smart' | 'package' | 'placement'>(sponsorship ? 'placement' : 'cpc');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<AdsOverview>(`/api/seller/advertising?section=${section}`, { auth: true }).then(setOverview).catch(() => {});
  }, [section]);
  useEffect(() => {
    load();
    api<AdsConfig>('/api/seller/advertising/config', { auth: true }).then(setConfig).catch(() => {});
    api<SellerPlanView>('/api/seller/billing/plan', { auth: true }).then(setPlan).catch(() => {});
  }, [load]);

  const discount = sponsorship && plan?.plan === 'PREMIUM' && config ? config.sponsorship.premiumDiscountPercent : 0;
  const gst = plan?.gstPercent ?? 18;

  /** Create a campaign or booking: `create` is one of the literal POST calls below. */
  async function submit<T>(create: () => Promise<T>, done: string | ((result: T) => string)) {
    setBusy(true);
    setMsg(null);
    try {
      const result = await create();
      setMsg({ ok: true, text: typeof done === 'function' ? done(result) : done });
      load();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/seller/advertising/${id}`, { method: 'PATCH', body, auth: true });
      load();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  return (
    <div className="space-y-4" data-ads-section={section}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">{sponsorship ? 'Sponsorship' : 'Advertising'}</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            {sponsorship
              ? 'Sponsor a product or a spot on Clowe. Shoppers always see a “Sponsored” label; organic results are never changed.'
              : 'Pay per click, a ready package, or a booked placement. Shoppers always see an “Ad” or “Sponsored” label; organic results are never changed.'}{' '}
            Prices are before GST ({gst}% is added).
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          {!sponsorship && (
            <div className="rounded-xl border border-gray-100 bg-white px-3 py-2">
              <p className="text-[11px] text-gray-500">Advertising credit</p>
              <p className="font-bold" data-ad-credit>{overview ? rupees(overview.adCreditPaise) : '—'}</p>
            </div>
          )}
          <div className="rounded-xl border border-gray-100 bg-white px-3 py-2">
            <p className="text-[11px] text-gray-500">Seller Wallet</p>
            <p className="font-bold">{overview ? rupees(overview.walletPaise) : '—'}</p>
            <Link href="/seller/billing" className="text-[11px] font-semibold text-brand-600 hover:underline">Top up</Link>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-gray-500">
        {sponsorship ? 'Paid from your Seller Wallet; whatever it cannot cover comes off your next payout.' : 'Advertising credit is spent first (no GST on it), then your Seller Wallet, then your next payout.'}
        {discount > 0 && <strong className="ml-1 text-green-700">Premium plan: {discount}% off sponsorship.</strong>}
      </p>

      {overview && (
        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <h2 className="mb-3 text-sm font-bold text-ink-900">Performance</h2>
          <MetricsGrid m={overview.totals} />
          {overview.byType.length > 0 && (
            <table className="mt-3 w-full text-xs">
              <thead className="text-left text-gray-500">
                <tr><th className="py-1">Slot</th><th>Impr.</th><th>Clicks</th><th>CTR</th><th>Spend</th></tr>
              </thead>
              <tbody>
                {overview.byType.map((t) => (
                  <tr key={t.slotType} className="border-t border-gray-100">
                    <td className="py-1">{CPC_AD_TYPE_LABELS[t.slotType as CpcAdType] ?? PLACEMENT_LABELS[t.slotType as PlacementKind] ?? t.slotType}</td>
                    <td>{t.impressions}</td><td>{t.clicks}</td><td>{t.ctr}%</td><td>{rupees(t.spendPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {config && (
        <section className="rounded-2xl border border-gray-100 bg-white p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {(sponsorship
              ? ([['placement', 'Book a sponsorship'], ['cpc', 'Sponsored product (per click)']] as const)
              : ([['cpc', 'Pay per click'], ['smart', 'Smart campaign'], ['package', 'Packages'], ['placement', 'Premium placements']] as const)
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setTab(k);
                  setMsg(null);
                }}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${tab === k ? 'bg-ink-900 text-white' : 'bg-gray-100 text-gray-700'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {config.products.length === 0 ? (
            <p className="text-sm text-gray-500">You need a live product first.</p>
          ) : tab === 'cpc' ? (
            <CpcForm config={config} sponsorship={sponsorship} discount={discount} busy={busy} onSubmit={(b) => submit(() => api('/api/seller/advertising/cpc', { method: 'POST', body: b, auth: true }), 'Campaign started.')} />
          ) : tab === 'smart' ? (
            <SmartForm config={config} busy={busy} onSubmit={(b) => submit(() => api('/api/seller/advertising/smart', { method: 'POST', body: b, auth: true }), 'Smart campaign started.')} />
          ) : tab === 'package' ? (
            <PackageForm config={config} gst={gst} busy={busy} onSubmit={(b) => submit(() => api('/api/seller/advertising/packages', { method: 'POST', body: b, auth: true }), 'Package booked.')} />
          ) : (
            <PlacementForm config={config} sponsorship={sponsorship} discount={discount} gst={gst} busy={busy} onSubmit={(b) => submit(
                  () => api<{ status: string }>('/api/seller/advertising/placements', { method: 'POST', body: b, auth: true }),
                  // Only a banner waits for Clowe's check; a featured product runs on its dates.
                  (booked) =>
                    booked.status === 'PENDING_APPROVAL'
                      ? 'Booked. Your banner runs once Clowe approves it; if it is not approved, the booking is refunded.'
                      : 'Booked. It runs on the dates you picked.',
                )} />
          )}
          {msg && <p className={`mt-3 text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`} role="status">{msg.text}</p>}
        </section>
      )}

      {sponsorship && config && <RateCard config={config} discount={discount} />}

      <section className="rounded-2xl border border-gray-100 bg-white p-4" data-campaigns>
        <h2 className="mb-3 text-sm font-bold text-ink-900">Your {sponsorship ? 'sponsorships' : 'campaigns'}</h2>
        {!overview ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : overview.campaigns.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {overview.campaigns.map((c) => (
              <CampaignRow key={c.id} c={c} onPatch={patch} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold text-ink-900">Need something bigger?</h2>
        <p className="mb-2 text-xs text-gray-500">Enterprise campaigns (₹9,999+) and custom placements are set up with vendor support.</p>
        <ContactVendorSupport topic={sponsorship ? 'sponsorship' : 'Enterprise advertising'} />
      </section>
    </div>
  );
}

function CampaignRow({ c, onPatch }: { c: AdCampaignRow; onPatch: (id: string, body: Record<string, unknown>) => void }) {
  const [edit, setEdit] = useState(false);
  const [bid, setBid] = useState(c.bidPaise ? String(c.bidPaise / 100) : '');
  const [daily, setDaily] = useState(c.dailyBudgetPaise ? String(c.dailyBudgetPaise / 100) : '');
  const canToggle = c.status === 'ACTIVE' || c.status === 'PAUSED';
  return (
    <li className="py-3 text-sm" data-campaign={c.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink-900">{c.name}</p>
          <p className="text-xs text-gray-500">
            {c.placement ? PLACEMENT_LABELS[c.placement] : c.packageKey ? `${c.packageKey} package` : c.adTypes.map((t) => CPC_AD_TYPE_LABELS[t]).join(', ')}
            {c.productTitle && ` · ${c.productTitle}`}
            {c.bidPaise != null && ` · bid ${rupees(c.bidPaise)}/click`}
            {c.dailyBudgetPaise != null && ` · ${rupees(c.dailyBudgetPaise)}/day`}
            {c.pricePaise > 0 && ` · ${rupees(c.pricePaise)} + GST`}
            {` · ${c.startAt.slice(0, 10)}${c.endAt ? ` → ${c.endAt.slice(0, 10)}` : ''}`}
          </p>
          {c.rejectionReason && <p className="text-xs text-red-600">{c.rejectionReason}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
          {canToggle && (
            <button type="button" onClick={() => onPatch(c.id, { status: c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })} className="text-xs font-semibold text-brand-600 hover:underline">
              {c.status === 'ACTIVE' ? 'Pause' : 'Resume'}
            </button>
          )}
          {canToggle && c.kind === 'CPC' && (
            <button type="button" onClick={() => setEdit(!edit)} className="text-xs font-semibold text-brand-600 hover:underline">Edit</button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {c.metrics.impressions} impressions · {c.metrics.clicks} clicks · CTR {c.metrics.ctr}% · {c.metrics.orders} orders · spend {rupees(c.metrics.spendPaise)}
        {c.metrics.spendPaise > 0 && ` · ROAS ${c.metrics.roas}×`}
      </p>
      {edit && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label="Bid per click (₹)"><input className={inputCls} value={bid} onChange={(e) => setBid(e.target.value)} inputMode="decimal" /></Field>
          <Field label="Daily budget (₹)"><input className={inputCls} value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" /></Field>
          <button
            type="button"
            onClick={() => {
              onPatch(c.id, { bidPaise: Math.round(Number(bid) * 100), dailyBudgetPaise: Math.round(Number(daily) * 100) });
              setEdit(false);
            }}
            className="rounded-lg bg-ink-900 px-3 py-2 text-xs font-semibold text-white"
          >
            Save
          </button>
        </div>
      )}
    </li>
  );
}

function ProductSelect({ config, value, onChange }: { config: AdsConfig; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Product">
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} name="productId">
        {config.products.map((p) => (
          <option key={p.id} value={p.id}>{p.title}</option>
        ))}
      </select>
    </Field>
  );
}

function CpcForm({ config, sponsorship, discount, busy, onSubmit }: { config: AdsConfig; sponsorship: boolean; discount: number; busy: boolean; onSubmit: (b: unknown) => void }) {
  const available = CPC_AD_TYPES.filter((t) => !config.ads.unavailableTypes.includes(t));
  const [productId, setProductId] = useState(config.products[0]!.id);
  const [types, setTypes] = useState<CpcAdType[]>(['SPONSORED_PRODUCT']);
  const [name, setName] = useState('');
  const [bid, setBid] = useState('');
  const [daily, setDaily] = useState('100');
  const [monthly, setMonthly] = useState('');
  const [lo, hi] = useMemo<[number, number]>(
    () =>
      sponsorship
        ? config.sponsorship.perClickRangePaise
        : types.reduce<[number, number]>((r, t) => [Math.max(r[0], config.ads.cpcRanges[t]![0]), Math.min(r[1], config.ads.cpcRanges[t]![1])], [0, Number.MAX_SAFE_INTEGER]),
    [types, sponsorship, config],
  );
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name: name || (sponsorship ? 'Sponsored product' : types.map((t) => CPC_AD_TYPE_LABELS[t]).join(' + ')),
          adTypes: sponsorship ? ['SPONSORED_PRODUCT'] : types,
          productId,
          bidPaise: Math.round(Number(bid) * 100),
          dailyBudgetPaise: Math.round(Number(daily) * 100),
          ...(monthly ? { monthlyBudgetPaise: Math.round(Number(monthly) * 100) } : {}),
          sponsorship,
        });
      }}
    >
      <ProductSelect config={config} value={productId} onChange={setProductId} />
      <Field label="Campaign name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali kurtas" name="name" /></Field>
      {!sponsorship && (
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-ink-900">Where it shows</legend>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {available.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} name={`type-${t}`} />
                {CPC_AD_TYPE_LABELS[t]} <span className="text-xs text-gray-500">{rupees(config.ads.cpcRanges[t]![0])}–{rupees(config.ads.cpcRanges[t]![1])}/click</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Field label="Bid per click (₹)" hint={lo <= hi ? `Between ${rupees(lo)} and ${rupees(hi)}${discount ? ` — you pay ${100 - discount}% of it on Premium` : ''}. Charged only for valid clicks (one per shopper a day; never your own).` : 'These types have no common range — pick fewer.'}>
        <input className={inputCls} value={bid} onChange={(e) => setBid(e.target.value)} inputMode="decimal" required name="bid" />
      </Field>
      <Field label="Daily budget (₹)" hint="Stops showing for the day once reached."><input className={inputCls} value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" required name="daily" /></Field>
      <Field label="Monthly budget (₹, optional)"><input className={inputCls} value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="decimal" name="monthly" /></Field>
      <div className="flex items-end">
        <button type="submit" disabled={busy || (!sponsorship && types.length === 0)} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Start campaign
        </button>
      </div>
    </form>
  );
}

function SmartForm({ config, busy, onSubmit }: { config: AdsConfig; busy: boolean; onSubmit: (b: unknown) => void }) {
  const [productId, setProductId] = useState(config.products[0]!.id);
  const [budget, setBudget] = useState('1000');
  const [days, setDays] = useState('7');
  const [goal, setGoal] = useState<'CLICKS' | 'ORDERS'>('ORDERS');
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name: `Smart — ${goal === 'ORDERS' ? 'orders' : 'clicks'}`, productId, totalBudgetPaise: Math.round(Number(budget) * 100), days: Number(days), goal });
      }}
    >
      <p className="text-xs text-gray-500 sm:col-span-2">Set a budget and a goal; Clowe spreads it across every ad slot, bidding inside each slot’s range.</p>
      <ProductSelect config={config} value={productId} onChange={setProductId} />
      <Field label="Goal">
        <select className={inputCls} value={goal} onChange={(e) => setGoal(e.target.value as 'CLICKS' | 'ORDERS')}>
          <option value="ORDERS">More orders (bids higher for top spots)</option>
          <option value="CLICKS">More clicks (bids lower, more clicks for the money)</option>
        </select>
      </Field>
      <Field label="Total budget (₹)"><input className={inputCls} value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" /></Field>
      <Field label="Days"><input className={inputCls} value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /></Field>
      <div><button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Start smart campaign</button></div>
    </form>
  );
}

function PackageForm({ config, gst, busy, onSubmit }: { config: AdsConfig; gst: number; busy: boolean; onSubmit: (b: unknown) => void }) {
  const [productId, setProductId] = useState(config.products[0]!.id);
  const [start, setStart] = useState(today());
  const [creative, setCreative] = useState('');
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <ProductSelect config={config} value={productId} onChange={setProductId} />
        <Field label="Start date"><input type="date" className={inputCls} value={start} min={today()} onChange={(e) => setStart(e.target.value)} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {AD_PACKAGES.map((k) => {
          const p = config.ads.packages[k]!;
          const enterprise = k === 'ENTERPRISE';
          return (
            <div key={k} className="rounded-xl border border-gray-200 p-3" data-package={k}>
              <p className="font-semibold text-ink-900">{PACKAGE_LABEL[k]}</p>
              <p className="font-display text-xl font-bold">{rupees(p.pricePaise)}{enterprise ? '+' : ''}</p>
              <p className="text-[11px] text-gray-500">{config.ads.campaignDays} days · + {gst}% GST</p>
              <ul className="mt-1 text-xs text-gray-600">
                {p.types.filter((t) => !config.ads.unavailableTypes.includes(t)).map((t) => <li key={t}>• {CPC_AD_TYPE_LABELS[t]}</li>)}
                {p.placements.map((pl) => <li key={pl}>• {PLACEMENT_LABELS[pl]}</li>)}
              </ul>
              {enterprise ? (
                <div className="mt-2"><ContactVendorSupport topic="Enterprise advertising package" /></div>
              ) : (
                <>
                  {p.placements.some((pl) => config.ads.placements[pl]?.needsCreative) && (
                    <BannerUpload value={creative} onChange={setCreative} />
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSubmit({ package: k, productId, startDate: start, ...(creative ? { creativeUrl: creative } : {}) })}
                    className="mt-2 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Buy {PACKAGE_LABEL[k]}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BannerUpload({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Field label="Banner image" hint="Checked by Clowe before it runs. Wide (3:1) works best.">
      <input
        type="file"
        accept="image/*"
        className="mt-1 block text-xs"
        name="creative"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true);
          try {
            const [url] = await uploadImages([f]);
            if (url) onChange(url);
          } finally {
            setBusy(false);
          }
        }}
      />
      {busy && <span className="text-[11px] text-gray-500">Uploading…</span>}
      {value && !busy && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="mt-1 h-12 rounded object-cover" />
      )}
    </Field>
  );
}

function PlacementForm({ config, sponsorship, discount, gst, busy, onSubmit }: { config: AdsConfig; sponsorship: boolean; discount: number; gst: number; busy: boolean; onSubmit: (b: unknown) => void }) {
  const kinds = PLACEMENT_KINDS.filter((k) => config.ads.placements[k] && config.ads.placements[k]!.sponsorship === sponsorship);
  const [placement, setPlacement] = useState<PlacementKind>(kinds[0]!);
  const rules = config.ads.placements[placement]!;
  const [productId, setProductId] = useState(config.products[0]!.id);
  const [categoryId, setCategoryId] = useState(config.categories[0]?.id ?? '');
  const [start, setStart] = useState(today());
  const [units, setUnits] = useState('1');
  const [creative, setCreative] = useState('');
  const [headline, setHeadline] = useState('');
  const needsCategory = PLACEMENT_SPACE[placement].startsWith('CATEGORY');
  const base = Math.round((rules.unit === 'CAMPAIGN' ? rules.pricePaise : rules.pricePaise * Math.max(1, Number(units) || 1)) * (1 - discount / 100));
  const unitWord = rules.unit === 'DAY' ? 'day' : rules.unit === 'WEEK' ? 'week' : `campaign (${config.ads.campaignDays} days)`;
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          placement,
          startDate: start,
          units: rules.unit === 'CAMPAIGN' ? 1 : Number(units),
          ...(needsCategory ? { categoryId } : {}),
          ...(rules.needsCreative ? { creativeUrl: creative || undefined, headline: headline || undefined } : { productId }),
        });
      }}
    >
      <Field label="Placement">
        <select className={inputCls} value={placement} onChange={(e) => setPlacement(e.target.value as PlacementKind)} name="placement">
          {kinds.map((k) => (
            <option key={k} value={k}>
              {PLACEMENT_LABELS[k]} — {rupees(config.ads.placements[k]!.pricePaise)}/{config.ads.placements[k]!.unit === 'DAY' ? 'day' : config.ads.placements[k]!.unit === 'WEEK' ? 'week' : 'campaign'}
            </option>
          ))}
        </select>
      </Field>
      {needsCategory && (
        <Field label="Category">
          <select className={inputCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} name="categoryId">
            {config.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      {rules.needsCreative ? (
        <>
          <BannerUpload value={creative} onChange={setCreative} />
          <Field label="Headline (optional)"><input className={inputCls} value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={80} name="headline" /></Field>
        </>
      ) : (
        <ProductSelect config={config} value={productId} onChange={setProductId} />
      )}
      <Field label="Start date"><input type="date" className={inputCls} value={start} min={today()} onChange={(e) => setStart(e.target.value)} name="startDate" /></Field>
      {rules.unit !== 'CAMPAIGN' && (
        <Field label={`How many ${rules.unit === 'DAY' ? 'days' : 'weeks'}`}><input className={inputCls} value={units} onChange={(e) => setUnits(e.target.value)} inputMode="numeric" name="units" /></Field>
      )}
      <div className="sm:col-span-2">
        <Availability placement={placement} categoryId={needsCategory ? categoryId : undefined} from={start} />
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={busy || (rules.needsCreative && !creative)} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Book for {rupees(base)} + GST
        </button>
        <span className="text-xs text-gray-500">
          {rupees(rules.pricePaise)} per {unitWord}{discount ? `, less ${discount}% (Premium)` : ''}; {gst}% GST added. {rules.slots > 1 ? `${rules.slots} sellers can hold it at once.` : 'One seller at a time.'}
        </span>
      </div>
    </form>
  );
}

function RateCard({ config, discount }: { config: AdsConfig; discount: number }) {
  const rows = PLACEMENT_KINDS.filter((k) => config.ads.placements[k]?.sponsorship);
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4" data-rate-card>
      <h2 className="mb-2 text-sm font-bold text-ink-900">Sponsorship rate card</h2>
      <table className="w-full text-sm">
        <tbody>
          <tr className="border-b border-gray-100">
            <td className="py-1.5">Sponsored Product</td>
            <td className="text-right">{rupees(config.sponsorship.perClickRangePaise[0])}–{rupees(config.sponsorship.perClickRangePaise[1])} per click</td>
          </tr>
          {rows.map((k) => {
            const r = config.ads.placements[k]!;
            const unit = r.unit === 'DAY' ? 'day' : r.unit === 'WEEK' ? 'week' : 'campaign';
            return (
              <tr key={k} className="border-b border-gray-100">
                <td className="py-1.5">{PLACEMENT_LABELS[k]}</td>
                <td className="text-right">
                  {r.rangePaise[0] !== r.rangePaise[1] ? `${rupees(r.rangePaise[0])}–${rupees(r.rangePaise[1])}` : rupees(r.pricePaise)} per {unit}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-gray-500">Before GST. Premium plan sellers get {config.sponsorship.premiumDiscountPercent}% off{discount ? ' — that’s you.' : '.'}</p>
    </section>
  );
}
