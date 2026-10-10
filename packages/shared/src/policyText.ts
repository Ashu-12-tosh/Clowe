import { fillReturnWindow } from './returnWindow';

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
/** Reads after "orders": "On orders {{freeShippingFrom}}" → "On orders of ₹999 or more". */
export const FREE_SHIPPING_TOKEN = '{{freeShippingFrom}}';

export interface PolicyValues {
  returnWindowDays?: number | null;
  dispatchSlaHours?: number | null;
  lateDispatchPenaltyAfterHours?: number | null;
  lateDispatchPenaltyPaise?: number | null;
  freeShippingThresholdPaise?: number | null;
}

function hours(n: number): string {
  return `${n} hour${n === 1 ? '' : 's'}`;
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/**
 * Which orders ship free, to follow the word "orders". Standard delivery is
 * free at or above the threshold, so "or more" rather than "above".
 */
export function freeShippingPhrase(thresholdPaise: number | null | undefined): string {
  if (thresholdPaise == null) return 'above the amount shown at checkout';
  if (thresholdPaise <= 0) return 'of any value';
  return `of ${rupees(thresholdPaise)} or more`;
}

/** Fill every policy token in `text` from settings (or `null` while they load). */
export function fillPolicyText(text: string, values: PolicyValues | null | undefined): string {
  const v = values ?? {};
  return fillReturnWindow(text, v.returnWindowDays)
    .split(DISPATCH_SLA_TOKEN)
    .join(v.dispatchSlaHours != null ? hours(v.dispatchSlaHours) : 'the dispatch time shown on each order')
    .split(PENALTY_AFTER_TOKEN)
    .join(
      v.lateDispatchPenaltyAfterHours != null
        ? hours(v.lateDispatchPenaltyAfterHours)
        : 'the penalty time shown on each order',
    )
    .split(PENALTY_AMOUNT_TOKEN)
    .join(v.lateDispatchPenaltyPaise != null ? rupees(v.lateDispatchPenaltyPaise) : 'a fixed penalty')
    .split(FREE_SHIPPING_TOKEN)
    .join(freeShippingPhrase(v.freeShippingThresholdPaise));
}
