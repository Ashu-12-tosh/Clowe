import type { CommercialSettings, SellerPlan } from './commercial';
import { bpsToPercent, slabFor, slabDescription, type ReferralFeeSlab } from './referralFees';
import { computeListingEconomics } from './sellerEconomics';

// ---------------------------------------------------------------------------
// The part of the commercial rules sellers and the public may see (owner's
// Batch 2): what the Seller Fees page, Schedule II of the Seller Terms, the
// FAQ and the registration popup quote. Clowe's own costs (cost per try-on
// credit, its tiers, the phase note) are never in it.
// ---------------------------------------------------------------------------

export interface CommercialPublic {
  fees: CommercialSettings['fees'];
  penalties: CommercialSettings['penalties'];
  plans: Pick<CommercialSettings['plans'], SellerPlan | 'graceDays'>;
  ads: Pick<CommercialSettings['ads'], 'cpcRanges' | 'unavailableTypes' | 'campaignDays' | 'packages' | 'placements' | 'welcomeCreditPaise' | 'attributionDays'>;
  sponsorship: CommercialSettings['sponsorship'];
  tryon: Pick<CommercialSettings['tryon'], 'packs' | 'extraCreditPaise' | 'expiryDays' | 'freeGrantCredits' | 'freeGrantSellers'>;
  /** The referral fee schedule in force, when one has taken effect (set by the API). */
  referral?: PublicReferralSchedule | null;
}

/** What the public pages say about the referral fee schedule. */
export interface PublicReferralSchedule {
  version: number;
  effectiveFrom: string;
  /** Worked examples: a product in a real category, at a price, with its GST rate. */
  examples: { title: string; pricePaise: number; gstRatePercent: number; sheetCategory: string; slabs: ReferralFeeSlab[] }[];
}

export function publicCommercial(c: CommercialSettings): CommercialPublic {
  const { FREE, GROWTH, PRO, PREMIUM, graceDays } = c.plans;
  const { cpcRanges, unavailableTypes, campaignDays, packages, placements, welcomeCreditPaise, attributionDays } = c.ads;
  const { packs, extraCreditPaise, expiryDays, freeGrantCredits, freeGrantSellers } = c.tryon;
  return {
    fees: c.fees,
    penalties: c.penalties,
    plans: { FREE, GROWTH, PRO, PREMIUM, graceDays },
    ads: { cpcRanges, unavailableTypes, campaignDays, packages, placements, welcomeCreditPaise, attributionDays },
    sponsorship: c.sponsorship,
    tryon: { packs, extraCreditPaise, expiryDays, freeGrantCredits, freeGrantSellers },
  };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${Number(n.toFixed(2))}%`;

/** "₹9 below ₹500; ₹14 from ₹500 to ₹999; …; ₹40 from ₹20,000" — per unit, by the unit's selling price. */
export function handlingFeesText(slabs: CommercialSettings['fees']['handlingSlabs']): string {
  const sorted = [...slabs].sort((a, b) => a.fromPaise - b.fromPaise);
  return sorted
    .map((s, i) => {
      const next = sorted[i + 1];
      if (i === 0 && next) return `${rupees(s.feePaise)} below ${rupees(next.fromPaise)}`;
      if (next) return `${rupees(s.feePaise)} from ${rupees(s.fromPaise)} to ${rupees(next.fromPaise - 100)}`;
      return `${rupees(s.feePaise)} from ${rupees(s.fromPaise)}`;
    })
    .join('; ');
}

/**
 * The same slabs one per line, for a schedule table: "Below ₹500: ₹9",
 * "₹500 – ₹999: ₹14", …, "₹20,000 and above: ₹40".
 */
export function handlingFeeLines(slabs: CommercialSettings['fees']['handlingSlabs']): string[] {
  const sorted = [...slabs].sort((a, b) => a.fromPaise - b.fromPaise);
  return sorted.map((s, i) => {
    const next = sorted[i + 1];
    if (i === 0 && !next) return rupees(s.feePaise);
    if (i === 0) return `Below ${rupees(next!.fromPaise)}: ${rupees(s.feePaise)}`;
    if (next) return `${rupees(s.fromPaise)} – ${rupees(next.fromPaise - 100)}: ${rupees(s.feePaise)}`;
    return `${rupees(s.fromPaise)} and above: ${rupees(s.feePaise)}`;
  });
}

/**
 * The worked examples: with a referral fee schedule in force, one per example
 * it carries (a shirt at ₹1,000 and at ₹1,500); otherwise a ₹1,000 sale at the
 * flat rate.
 */
export function feeExamplesMarkdown(c: CommercialPublic, tdsPercent: number, tcsPercent: number): string {
  const examples = c.referral?.examples ?? [];
  if (examples.length === 0) return feeExampleMarkdown(c, tdsPercent, tcsPercent);
  return examples
    .map((x) => `**${x.title}**\n\n${feeExampleMarkdown(c, tdsPercent, tcsPercent, x.pricePaise, x.gstRatePercent, { sheetCategory: x.sheetCategory, slabs: x.slabs }, false)}`)
    .join('\n\n')
    .concat('\n\nCourier charges (forward freight, and the COD fee on a Cash on Delivery order) come on top, at the courier’s actual rates.');
}

/**
 * A worked example as a markdown list: a sale at `pricePaise` (GST included)
 * under the fees in force, with the statutory TDS and TCS — the same maths the
 * ledger posts. With `referral`, the referral fee is the slab's for the price.
 */
export function feeExampleMarkdown(
  c: CommercialPublic,
  tdsPercent: number,
  tcsPercent: number,
  pricePaise = 100_000,
  gstPercent = 18,
  referral: { sheetCategory: string; slabs: ReferralFeeSlab[] } | null = null,
  courierNote = true,
): string {
  const slab = referral ? slabFor(referral.slabs, pricePaise) : null;
  const e = computeListingEconomics({
    buyerPricePaise: pricePaise,
    gstRatePercent: gstPercent,
    rates: {
      commissionPercent: 0,
      gatewayPercent: 0,
      tdsPercent,
      tcsPercent,
      gst: { meritPercent: gstPercent, standardPercent: gstPercent, valueSlabThresholdPaise: 0, uniformPercent: gstPercent },
      platformFeePaise: 0,
      closingFeePaise: 0,
      gtChargePaise: 0,
      v2: { ...c.fees, referralSlabs: referral?.slabs ?? null, handlingWaived: false },
    },
  });
  const row = (key: string) => -(e.lines.find((l) => l.key === key)?.amountPaise ?? 0);
  const feesBase = row('commission') + row('gt') + row('gateway') + row('handling');
  const referralLine = slab
    ? `- Referral fee ${pct(bpsToPercent(slab.rateBps))} (${referral!.sheetCategory}, ${slabDescription(slab)}${slab.borrowedFrom ? ` — the ${slab.borrowedFrom} rate` : ''}): ${rupees(row('commission'))}`
    : `- Referral fee ${pct(c.fees.referralPercent)}: ${rupees(row('commission'))}`;
  return [
    `A buyer pays ${rupees(pricePaise)} for one unit (GST ${gstPercent}% included):`,
    '',
    referralLine,
    `- GT charge ${pct(c.fees.gtPercent)}: ${rupees(row('gt'))}`,
    `- Payment collection fee ${pct(c.fees.collectionPercent)}: ${rupees(row('gateway'))}`,
    `- Handling fee: ${rupees(row('handling'))}`,
    `- Clowe's fees: ${rupees(feesBase)}, plus GST ${pct(c.fees.gstPercent)} on them: ${rupees(row('feeGst'))}`,
    `- TDS ${pct(tdsPercent)} and TCS ${pct(tcsPercent)} (by law, on the price before GST): ${rupees(row('tds'))} and ${rupees(row('tcs'))}`,
    `- **You receive ${rupees(e.sellerReceivesPaise)}**, from which you pay the GST on your sale (${rupees(e.gstPaise)}) — you keep ${rupees(e.sellerKeepsAfterGstPaise)}.`,
    ...(courierNote ? ['', 'Courier charges (forward freight, and the COD fee on a Cash on Delivery order) come on top, at the courier’s actual rates.'] : []),
  ].join('\n');
}
