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
  gstUniformPercent?: number | null;
  sellerFees?: Partial<SellerFeeSchedule> | null;
  supportEmails?: { customer?: string; vendor?: string } | null;
  nonReturnableCategories?: string[] | null;
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
  return {
    [DISPATCH_SLA_TOKEN]: v.dispatchSlaHours != null ? hours(v.dispatchSlaHours) : 'the dispatch time shown on each order',
    [PENALTY_AFTER_TOKEN]:
      v.lateDispatchPenaltyAfterHours != null ? hours(v.lateDispatchPenaltyAfterHours) : 'the penalty time shown on each order',
    [PENALTY_AMOUNT_TOKEN]: v.lateDispatchPenaltyPaise != null ? rupees(v.lateDispatchPenaltyPaise) : 'a fixed penalty',
    '{{sellerCancelPenalty}}': v.sellerCancelPenaltyPaise != null ? rupees(v.sellerCancelPenaltyPaise) : 'a fixed penalty',
    '{{codMax}}': v.codMaxOrderPaise != null ? rupees(v.codMaxOrderPaise) : 'the limit shown at checkout',
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
