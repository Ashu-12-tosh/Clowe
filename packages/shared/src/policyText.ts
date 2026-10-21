import { feeExamplesMarkdown, handlingFeesText, type CommercialPublic } from './commercialPublic';
import { fillReturnWindow } from './returnWindow';
import { PACKING_VIDEO_RETENTION_DAYS } from './sellerOrders';
import type { SellerFeeSchedule } from './settings';
import { TRYON_PHOTO_RETENTION_HOURS } from './tryon';

// ---------------------------------------------------------------------------
// Platform rules in copy.
//
// Help articles, policies and FAQ answers never spell out a rule's number:
// they carry a token, and the page that shows them fills it from platform
// settings. Unknown values get a phrase that is true without a number.
// ---------------------------------------------------------------------------

export const DISPATCH_SLA_TOKEN = '{{dispatchSla}}';
export const PENALTY_AFTER_TOKEN = '{{penaltyAfter}}';
export const PENALTY_AMOUNT_TOKEN = '{{penaltyAmount}}';

export interface PolicyValues {
  returnWindowDays?: number | null;
  dispatchSlaHours?: number | null;
  lateDispatchPenaltyAfterHours?: number | null;
  lateDispatchPenaltyPaise?: number | null;
  sellerCancelPenaltyPaise?: number | null;
  codMaxOrderPaise?: number | null;
  codMinOrderPaise?: number | null;
  gstUniformPercent?: number | null;
  sellerFees?: Partial<SellerFeeSchedule> | null;
  supportEmails?: { customer?: string; vendor?: string } | null;
  nonReturnableCategories?: string[] | null;
  /** The owner's commercial rules as sellers see them (Batch 2). */
  commercial?: CommercialPublic | null;
}

function hours(n: number): string {
  return `${n} hour${n === 1 ? '' : 's'}`;
}

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function percent(n: number): string {
  return `${Number(n.toFixed(2))}%`;
}

/**
 * Every token a policy text may carry: what fills it, and what it reads when
 * the setting is not known (the API could not be reached).
 */
function tokens(v: PolicyValues): Record<string, string> {
  const fees = v.sellerFees ?? {};
  const fee = <K extends keyof SellerFeeSchedule>(key: K, show: (n: number) => string, otherwise: string) =>
    fees[key] != null ? show(fees[key] as number) : otherwise;
  const onPayouts = 'the amount shown on your Payouts page';
  const c = v.commercial ?? null;
  const onFeesPage = 'the amount on the Seller Fees page';
  const plan = (k: 'FREE' | 'GROWTH' | 'PRO' | 'PREMIUM', name: string) => {
    const p = c?.plans[k];
    if (!p) return name;
    const limit = p.maxLiveProducts == null ? 'unlimited live products' : `up to ${p.maxLiveProducts} live products`;
    return `${name} ${p.pricePaise ? `${rupees(p.pricePaise)} a month` : 'free'} (${limit}${p.monthlyAdCreditPaise ? `, ${rupees(p.monthlyAdCreditPaise)} advertising credit a month` : ''}${p.waivesHandlingFee ? ', no handling fee' : ''})`;
  };
  return {
    [DISPATCH_SLA_TOKEN]: v.dispatchSlaHours != null ? hours(v.dispatchSlaHours) : 'the dispatch time shown on each order',
    [PENALTY_AFTER_TOKEN]:
      v.lateDispatchPenaltyAfterHours != null ? hours(v.lateDispatchPenaltyAfterHours) : 'the penalty time shown on each order',
    [PENALTY_AMOUNT_TOKEN]: v.lateDispatchPenaltyPaise != null ? rupees(v.lateDispatchPenaltyPaise) : 'a fixed penalty',
    '{{sellerCancelPenalty}}': v.sellerCancelPenaltyPaise != null ? rupees(v.sellerCancelPenaltyPaise) : 'a fixed penalty',
    '{{codMax}}': v.codMaxOrderPaise != null ? rupees(v.codMaxOrderPaise) : 'the limit shown at checkout',
    '{{codMin}}': v.codMinOrderPaise != null ? rupees(v.codMinOrderPaise) : 'the minimum shown at checkout',
    '{{gst}}': v.gstUniformPercent != null ? percent(v.gstUniformPercent) : 'the rate shown on each product',
    '{{commission}}': fee('commissionPercent', percent, 'the rate shown on your Payouts page'),
    '{{gatewayFee}}': fee('gatewayPercent', percent, 'the rate shown on your Payouts page'),
    '{{platformFee}}': fee('platformFeePaise', rupees, onPayouts),
    '{{closingFee}}': fee('closingFeePaise', rupees, onPayouts),
    '{{gtCharge}}': fee('gtChargePaise', rupees, onPayouts),
    '{{tds}}': fee('tdsPercent', percent, 'the rate set by law'),
    '{{tcs}}': fee('tcsPercent', percent, 'the rate set by law'),
    '{{payoutHold}}': fee('payoutHoldDays', days, 'the clearing period shown on your Payouts page'),
    '{{payoutMin}}': fee('payoutMinPaise', rupees, onPayouts),
    '{{referralFee}}': c?.referral
      ? 'set by the product’s category and its selling price — each category has price slabs, and the rate of the slab the price falls in applies to the whole price (see the [Referral Fee Schedule](/pages/referral-fee-schedule))'
      : c
        ? percent(c.fees.referralPercent)
        : 'the referral rate of the product’s category',
    '{{gtFee}}': c ? percent(c.fees.gtPercent) : onFeesPage,
    '{{collectionFee}}': c ? percent(c.fees.collectionPercent) : onFeesPage,
    '{{handlingFees}}': c ? handlingFeesText(c.fees.handlingSlabs) : 'the per-unit amount on the Seller Fees page',
    '{{cloweGst}}': c ? percent(c.fees.gstPercent) : 'the applicable rate',
    '{{counterfeitPenalty}}': c ? rupees(c.penalties.counterfeitListingPaise) : 'a fixed penalty',
    '{{tryonDataPenalty}}': c ? rupees(c.penalties.inaccurateTryOnDataPaise) : 'a fixed penalty',
    '{{sellerPlans}}': [plan('FREE', 'Free'), plan('GROWTH', 'Growth'), plan('PRO', 'Pro'), plan('PREMIUM', 'Premium')].join('; '),
    '{{planGraceDays}}': c ? days(c.plans.graceDays) : 'a few days',
    '{{welcomeAdCredit}}': c ? rupees(c.ads.welcomeCreditPaise) : 'a welcome advertising credit',
    '{{tryonPacks}}': c ? c.tryon.packs.map((p) => `${p.credits} credits ${rupees(p.pricePaise)}`).join('; ') : 'the packs on your AI Try-On page',
    '{{tryonExtraCredit}}': c ? rupees(c.tryon.extraCreditPaise) : 'a per-credit price',
    '{{tryonFreeGrant}}': c ? `${c.tryon.freeGrantCredits} free credits for each of the first ${c.tryon.freeGrantSellers} approved sellers` : 'free credits for the first approved sellers',
    '{{tryonExpiry}}': c ? (c.tryon.expiryDays ? `credits expire ${days(c.tryon.expiryDays)} after they are added` : 'credits do not expire') : 'credits expire as shown on your AI Try-On page',
    '{{feeExample}}': c ? feeExamplesMarkdown(c, fees.tdsPercent ?? 0.1, fees.tcsPercent ?? 0.5) : 'Your Payouts page and the pricing calculator show the exact amount for every order.',
    '{{tryonPhotoRetention}}': hours(TRYON_PHOTO_RETENTION_HOURS),
    '{{packingVideoDays}}': days(PACKING_VIDEO_RETENTION_DAYS),
    '{{customerSupportEmail}}': v.supportEmails?.customer || 'our customer support email',
    '{{vendorSupportEmail}}': v.supportEmails?.vendor || 'our seller support email',
    '{{nonReturnableCategories}}': !v.nonReturnableCategories
      ? 'the categories whose products say "Not returnable"'
      : v.nonReturnableCategories.length
        ? v.nonReturnableCategories.join(', ')
        : 'none at the moment',
  };
}

/** Fill every policy token in `text` from settings (or `null` while they load). */
export function fillPolicyText(text: string, values: PolicyValues | null | undefined): string {
  const v = values ?? {};
  let out = fillReturnWindow(text, v.returnWindowDays);
  for (const [token, value] of Object.entries(tokens(v))) out = out.split(token).join(value);
  return out;
}

/** Every token fillPolicyText knows, so a page can be checked for a typo'd one. */
export const POLICY_TOKENS: readonly string[] = ['{{returnWindow}}', ...Object.keys(tokens({}))];
