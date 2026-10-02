'use client';

import { useEffect, useState } from 'react';
import {
  AD_DURATIONS,
  AD_PLACEMENTS,
  AD_PLACEMENT_LABELS,
  type PlatformSettings,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

/** Paise → editable rupee string and back. */
const toRupees = (paise: number) => String(Math.round(paise / 100));
const toPaise = (rupees: string) => Math.max(0, Math.round(Number(rupees || '0') * 100));

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [tryonMin, setTryonMin] = useState('');
  const [kycMinScore, setKycMinScore] = useState('');
  const [social, setSocial] = useState({ facebook: '', twitter: '', instagram: '', linkedin: '' });
  const [supportEmails, setSupportEmails] = useState({ customer: '', vendor: '' });
  const [codMaxRupees, setCodMaxRupees] = useState('');
  const [adPrices, setAdPrices] = useState<Record<string, string>>({});
  const [payout, setPayout] = useState({
    commission: '',
    gateway: '',
    tds: '',
    minRupees: '',
    holdDays: '',
  });
  const [couponsEnabled, setCouponsEnabled] = useState(false);
  const [dispatch, setDispatch] = useState({ windowHours: '', penaltyRupees: '', enabled: true });
  const [economics, setEconomics] = useState({
    gstMerit: '',
    gstStandard: '',
    gstThresholdRupees: '',
    platformRupees: '',
    deliveryRupees: '',
    closingRupees: '',
  });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PlatformSettings>('/api/admin/settings', { auth: true })
      .then((s) => {
        setSettings(s);
        setTryonMin(toRupees(s.tryonMinPricePaise));
        setKycMinScore(String(s.kycNameMatchMinScore));
        setCouponsEnabled(s.couponsEnabled);
        setSocial(s.socialLinks);
        setSupportEmails(s.supportEmails);
        setCodMaxRupees(toRupees(s.codMaxOrderPaise));
        const prices: Record<string, string> = {};
        for (const pl of AD_PLACEMENTS)
          for (const d of AD_DURATIONS)
            prices[`${pl}:${d}`] = toRupees(s.adPricing[pl][String(d) as '7' | '15' | '30']);
        setAdPrices(prices);
        setEconomics({
          gstMerit: String(s.gstMeritPercent),
          gstStandard: String(s.gstStandardPercent),
          gstThresholdRupees: toRupees(s.gstValueSlabThresholdPaise),
          platformRupees: toRupees(s.platformFeePaise),
          deliveryRupees: toRupees(s.deliveryFeePaise),
          closingRupees: toRupees(s.closingFeePaise),
        });
        setDispatch({
          windowHours: String(s.dispatchWindowHours),
          penaltyRupees: toRupees(s.lateDispatchPenaltyPaise),
          enabled: s.penaltyEnabled,
        });
        setPayout({
          commission: String(s.payoutCommissionPercent),
          gateway: String(s.payoutGatewayPercent),
          tds: String(s.payoutTdsPercent),
          minRupees: toRupees(s.payoutMinPaise),
          holdDays: String(s.payoutHoldDays),
        });
      })
      .catch(() => setError('Could not load settings'));
  }, []);

  async function save() {
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      const adPricing = {
        HOME_BANNER: { '7': 0, '15': 0, '30': 0 },
        CATEGORY_SPONSORED: { '7': 0, '15': 0, '30': 0 },
      } as PlatformSettings['adPricing'];
      for (const pl of AD_PLACEMENTS)
        for (const d of AD_DURATIONS)
          adPricing[pl][String(d) as '7' | '15' | '30'] = toPaise(adPrices[`${pl}:${d}`]);

      const fresh = await api<PlatformSettings>('/api/admin/settings', {
        method: 'PUT',
        body: {
          tryonMinPricePaise: toPaise(tryonMin),
          socialLinks: social,
          supportEmails,
          codMaxOrderPaise: toPaise(codMaxRupees),
          adPricing,
          payoutCommissionPercent: Number(payout.commission) || 0,
          payoutGatewayPercent: Number(payout.gateway) || 0,
          payoutTdsPercent: Number(payout.tds) || 0,
          payoutMinPaise: toPaise(payout.minRupees),
          payoutHoldDays: Math.max(0, Math.round(Number(payout.holdDays) || 0)),
          kycNameMatchMinScore: Math.min(100, Math.max(0, Math.round(Number(kycMinScore) || 0))),
          couponsEnabled,
          dispatchWindowHours: Math.max(1, Math.round(Number(dispatch.windowHours) || 0)),
          lateDispatchPenaltyPaise: toPaise(dispatch.penaltyRupees),
          penaltyEnabled: dispatch.enabled,
          gstMeritPercent: Number(economics.gstMerit) || 0,
          gstStandardPercent: Number(economics.gstStandard) || 0,
          gstValueSlabThresholdPaise: toPaise(economics.gstThresholdRupees),
          platformFeePaise: toPaise(economics.platformRupees),
          deliveryFeePaise: toPaise(economics.deliveryRupees),
          closingFeePaise: toPaise(economics.closingRupees),
        },
        auth: true,
      });
      setSettings(fresh);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  }

  if (!settings && !error) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-1 text-sm text-gray-500">Platform-wide controls — saved instantly for the whole site.</p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {saved && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          ✓ Settings saved
        </div>
      )}

      {/* Try-On */}
      <div className="mt-5 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">✨ AI Try-On</h2>
        <label className="mt-3 block text-sm font-medium">Minimum product price for Try-On (₹)</label>
        <input
          type="number"
          min={0}
          value={tryonMin}
          onChange={(e) => setTryonMin(e.target.value)}
          className={`mt-1 ${field}`}
        />
        <p className="mt-1 text-xs text-gray-400">
          The Try On Me button appears only on products at or above this price. Enforced server-side too.
        </p>
      </div>

      {/* Seller KYC */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">🪪 Seller KYC</h2>
        <label className="mt-3 block text-sm font-medium">Minimum name-match score (0–100)</label>
        <input
          type="number"
          min={0}
          max={100}
          value={kycMinScore}
          onChange={(e) => setKycMinScore(e.target.value)}
          className={`mt-1 ${field}`}
        />
        <p className="mt-1 text-xs text-gray-400">
          PAN and bank-account names scoring below this are flagged before approval. Bands: 100 direct
          match, 85–99 good partial, 60–84 moderate partial, 34–59 poor partial, 0–33 no match. Changing
          it re-grades every seller at once — nothing is re-verified or re-billed.
        </p>
      </div>

      {/* Coupons */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">&#127903; Coupons</h2>
        <label className="mt-2 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={couponsEnabled}
            onChange={(e) => setCouponsEnabled(e.target.checked)}
            className="mt-0.5"
          />
          <span>Offer coupons to shoppers</span>
        </label>
        <p className="mt-1 text-xs text-gray-400">
          Off hides the checkout and cart coupon boxes and &ldquo;My Coupons&rdquo;, and the API
          stops honouring codes. Nothing is deleted &mdash; the coupons, their history and the
          discount on past orders all stay, and switching this back on restores the feature
          as it was. It also governs seller promo codes, which are redeemed through the same
          box, so sellers cannot create a code while this is off.
        </p>
      </div>

      {/* Social links */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">🔗 Social links (footer)</h2>
        <p className="mt-1 text-xs text-gray-400">Leave one empty and that icon is simply not shown.</p>
        {(['facebook', 'twitter', 'instagram', 'linkedin'] as const).map((key) => (
          <div key={key} className="mt-3">
            <label className="block text-sm font-medium capitalize">{key}</label>
            <input
              type="url"
              value={social[key]}
              onChange={(e) => setSocial((s) => ({ ...s, [key]: e.target.value }))}
              placeholder={`https://${key}.com/clowe`}
              className={`mt-1 ${field}`}
            />
          </div>
        ))}
      </div>

      {/* Support addresses */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">✉ Support email addresses</h2>
        <p className="mt-1 text-xs text-gray-400">
          Where &ldquo;Email support&rdquo; goes on the help centre (shoppers) and the seller support page.
        </p>
        {(
          [
            ['customer', 'Customer support'],
            ['vendor', 'Seller support'],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="mt-3">
            <label className="block text-sm font-medium">{label}</label>
            <input
              type="email"
              value={supportEmails[key]}
              onChange={(e) => setSupportEmails((s) => ({ ...s, [key]: e.target.value }))}
              className={`mt-1 ${field}`}
            />
          </div>
        ))}
      </div>

      {/* Cash on Delivery */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">💵 Cash on Delivery</h2>
        <p className="mt-1 text-xs text-gray-400">
          Offered up to this order total; above it the shopper must pay online. Checked when the
          order is placed, for checkout and phone orders alike. Sellers can still switch COD off for
          their own goods in their store settings.
        </p>
        <div className="mt-3">
          <label className="text-xs text-gray-500">Maximum COD order (₹)</label>
          <input
            type="number"
            min={0}
            value={codMaxRupees}
            onChange={(e) => setCodMaxRupees(e.target.value)}
            className={field}
          />
        </div>
      </div>

      {/* Dispatch window & late penalty */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">⏱ Dispatch window &amp; late penalty</h2>
        <p className="mt-1 text-xs text-gray-400">
          Sellers see a countdown on every unshipped line. A line marked shipped after the window
          posts one penalty to that seller&rsquo;s ledger, once, however the line was shipped. The
          clock is wall-clock: night orders still count against the window &mdash; an order placed
          at 11pm on a 12-hour window is due at 11am. Waiving a penalty from the seller&rsquo;s
          ledger exists for exactly that case.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs text-gray-500">Dispatch window (hours)</label>
            <input
              type="number"
              min={1}
              max={336}
              value={dispatch.windowHours}
              onChange={(e) => setDispatch((d) => ({ ...d, windowHours: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Late-dispatch penalty (₹)</label>
            <input
              type="number"
              min={0}
              value={dispatch.penaltyRupees}
              onChange={(e) => setDispatch((d) => ({ ...d, penaltyRupees: e.target.value }))}
              className={field}
            />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={dispatch.enabled}
              onChange={(e) => setDispatch((d) => ({ ...d, enabled: e.target.checked }))}
            />
            <span>Charge the penalty</span>
          </label>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Switching it off stops new penalties; entries already on a ledger stay as they are.
        </p>
      </div>

      {/* Seller payouts */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">₹ Seller payouts</h2>
        <p className="mt-1 text-xs text-gray-400">
          What the marketplace withholds from a seller&rsquo;s delivered sales. Every seller&rsquo;s
          payout page explains these rates back to them.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs text-gray-500">Commission (%)</label>
            <input
              type="number"
              min={0}
              max={50}
              step="0.5"
              value={payout.commission}
              onChange={(e) => setPayout((p) => ({ ...p, commission: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Gateway / collection (%)</label>
            <input
              type="number"
              min={0}
              max={20}
              step="0.5"
              value={payout.gateway}
              onChange={(e) => setPayout((p) => ({ ...p, gateway: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">TDS 194-O (%)</label>
            <input
              type="number"
              min={0}
              max={20}
              step="0.1"
              value={payout.tds}
              onChange={(e) => setPayout((p) => ({ ...p, tds: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Minimum payout (₹)</label>
            <input
              type="number"
              min={0}
              value={payout.minRupees}
              onChange={(e) => setPayout((p) => ({ ...p, minRupees: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Clearing hold (days)</label>
            <input
              type="number"
              min={0}
              max={90}
              value={payout.holdDays}
              onChange={(e) => setPayout((p) => ({ ...p, holdDays: e.target.value }))}
              className={field}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Earnings are released this many days after delivery — keep it at or above the return
          window so refunds never chase money that has already left.
        </p>
      </div>

      {/* Listing economics */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">🧮 Listing economics</h2>
        <p className="mt-1 text-xs text-gray-400">
          The fixed fees behind the pricing breakdown sellers see as they type a price, and
          behind the entries posted to their ledger on delivery &mdash; one shared formula, with
          the commission, gateway and TDS rates below.
        </p>
        <p className="mt-2 text-xs text-gray-400">
          GST is not one platform rate: each category carries its own (Categories page), and these
          three settings drive the GST 2.0 value slab for apparel, made-up textiles and footwear
          &mdash; the merit rate when one piece or pair is worth at most the threshold ex-GST, the
          standard rate above it. The standard rate is also used for any category with no rate.
          Notification 9/2025-Central Tax (Rate), in force 22 September 2025.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs text-gray-500">GST merit rate (%)</label>
            <input
              type="number"
              min={0}
              max={40}
              step="0.5"
              value={economics.gstMerit}
              onChange={(e) => setEconomics((v) => ({ ...v, gstMerit: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">GST standard rate (%)</label>
            <input
              type="number"
              min={0}
              max={40}
              step="0.5"
              value={economics.gstStandard}
              onChange={(e) => setEconomics((v) => ({ ...v, gstStandard: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Value-slab threshold (₹ per piece, ex-GST)</label>
            <input
              type="number"
              min={0}
              value={economics.gstThresholdRupees}
              onChange={(e) => setEconomics((v) => ({ ...v, gstThresholdRupees: e.target.value }))}
              className={field}
            />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs text-gray-500">Platform fee (₹, per line)</label>
            <input
              type="number"
              min={0}
              value={economics.platformRupees}
              onChange={(e) => setEconomics((v) => ({ ...v, platformRupees: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Delivery fee (₹, per shipment)</label>
            <input
              type="number"
              min={0}
              value={economics.deliveryRupees}
              onChange={(e) => setEconomics((v) => ({ ...v, deliveryRupees: e.target.value }))}
              className={field}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">Closing fee (₹, per unit)</label>
            <input
              type="number"
              min={0}
              value={economics.closingRupees}
              onChange={(e) => setEconomics((v) => ({ ...v, closingRupees: e.target.value }))}
              className={field}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          A single GST rate for the whole catalog is a simplification: category-wise GST (books
          0%, apparel under ₹1,000 at 5%) is a known follow-up. The tax invoice already applies
          the category rules; this rate only drives what sellers are shown. The closing fee is a
          placeholder until real logistics costs are known. Buyers are not charged any of these
          &mdash; they come out of the seller&rsquo;s settlement.
        </p>
      </div>

      {/* Ad pricing */}
      <div className="mt-3 rounded-2xl border border-gray-100 bg-white p-4">
        <h2 className="text-sm font-bold">📣 Ad pricing (₹, per placement & duration)</h2>
        {AD_PLACEMENTS.map((pl) => (
          <div key={pl} className="mt-3">
            <p className="text-sm font-medium">{AD_PLACEMENT_LABELS[pl]}</p>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {AD_DURATIONS.map((d) => (
                <div key={d}>
                  <label className="text-xs text-gray-500">{d} days</label>
                  <input
                    type="number"
                    min={0}
                    value={adPrices[`${pl}:${d}`] ?? ''}
                    onChange={(e) => setAdPrices((p) => ({ ...p, [`${pl}:${d}`]: e.target.value }))}
                    className={field}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => void save()}
        disabled={busy}
        className="mt-5 w-full rounded-xl bg-ink-900 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50 sm:w-auto sm:px-10"
      >
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  );
}
