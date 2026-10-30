import { MAX_DELIVERY_ATTEMPTS } from './deliveryZone';

// ---------------------------------------------------------------------------
// Order tracking as a buyer reads it: one bar per parcel
// (Ordered → Packed → Shipped → Out for delivery → Delivered), a plain-words
// headline above it, and anything gone wrong (a failed attempt, a delay, a
// hold, a cancellation, a return to the seller, a lost parcel) shown as its
// own box — never as a step. Returns after delivery get the same treatment
// (Requested → Pickup scheduled → Picked up → Received → Refund / exchange).
//
// Pure: the API gathers the parcel, its lines and Delhivery's scans and calls
// these; the web only renders what comes back. Dates are India time.
// ---------------------------------------------------------------------------

export type TrackStepKey = 'ORDERED' | 'PACKED' | 'SHIPPED' | 'OUT_FOR_DELIVERY' | 'DELIVERED';
export type ReturnStepKey = 'REQUESTED' | 'PICKUP_SCHEDULED' | 'PICKED_UP' | 'RECEIVED' | 'REFUNDED' | 'EXCHANGE_SHIPPED';
export type TrackStepState = 'done' | 'current' | 'upcoming';
/** info: moving · success: delivered / refunded · warning: needs a look · danger: not coming · muted: cancelled. */
export type TrackTone = 'info' | 'success' | 'warning' | 'danger' | 'muted';
export type TrackExceptionKind = 'FAILED_ATTEMPT' | 'DELAYED' | 'HELD' | 'NOT_PICKED' | 'CANCELLED' | 'RTO' | 'LOST' | 'DAMAGED' | 'RETURN_REJECTED' | 'PICKUP_FAILED';

export interface TrackStep<K extends string = string> {
  key: K;
  label: string;
  /** When it happened (ISO); null for a step not reached, or reached without a time. */
  at: string | null;
  state: TrackStepState;
}

export interface TrackException {
  kind: TrackExceptionKind;
  title: string;
  detail: string;
  /** What happens next, in a sentence; null when nothing does. */
  next: string | null;
}

/** One courier scan as the buyer sees it: newest first in every list. */
export interface TrackScanView {
  at: string;
  /** What happened, in plain words. */
  description: string;
  /** The city or hub, cleaned of Delhivery's codes. */
  location: string | null;
}

export interface ReturnTracking {
  returnId: string;
  itemTitle: string;
  rmaNumber: string;
  chip: string;
  headline: string;
  tone: TrackTone;
  steps: TrackStep<ReturnStepKey>[];
  exception: TrackException | null;
  scans: TrackScanView[];
}

export interface ParcelTrackingCore {
  /** A word or two for a status chip: "Arriving", "Out for delivery", "Delayed"… */
  chip: string;
  headline: string;
  tone: TrackTone;
  steps: TrackStep<TrackStepKey>[];
  exception: TrackException | null;
  /** The date the headline promises (ISO), when there is one. */
  expectedAt: string | null;
  scans: TrackScanView[];
}

export interface ParcelTracking extends ParcelTrackingCore {
  /** The shipment id, or a stand-in for lines not booked with the courier yet. */
  key: string;
  shipmentId: string | null;
  shopName: string;
  items: { id: string; title: string; quantity: number }[];
  courierName: string | null;
  awbNumber: string | null;
  /** When we last heard from the courier (ISO). */
  lastUpdatedAt: string | null;
  /** True while the parcel is moving and booked: "Refresh" may ask the courier. */
  canRefresh: boolean;
  returns: ReturnTracking[];
}

export interface OrderTrackingSummary {
  chip: string;
  headline: string;
  tone: TrackTone;
}

/** The buyer's "Refresh" asks the courier about a parcel at most this often. */
export const TRACK_REFRESH_MINUTES = 10;

// --- Dates ----------------------------------------------------------------

const IST = 'Asia/Kolkata';
const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: IST });
const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: IST });
const keyFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: IST });

/** "Tue, 3 Nov". */
export function trackDay(d: Date | string): string {
  return dayFmt.format(new Date(d));
}
/** "3:40 PM". */
export function trackTime(d: Date | string): string {
  return timeFmt.format(new Date(d)).replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toUpperCase()}`);
}
/** "Mon, 2 Nov, 3:40 PM". */
export function trackDayTime(d: Date | string): string {
  return `${trackDay(d)}, ${trackTime(d)}`;
}
/** The India-time calendar day, YYYY-MM-DD, for comparing days. */
function dayKey(d: Date): string {
  return keyFmt.format(d);
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((Date.parse(dayKey(b)) - Date.parse(dayKey(a))) / 86_400_000);
}
/** "today", "tomorrow" or "Tue, 3 Nov". */
function relativeDay(d: Date, now: Date): string {
  const n = daysBetween(now, d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return trackDay(d);
}

// --- Scans in plain words ---------------------------------------------------

export interface TrackScanInput {
  at: Date;
  status: string;
  statusType: string;
  code: string;
  location: string | null;
  instructions: string | null;
}

/** The courier's own words, tidied: no long digit runs (phones), no SHOUTING, not too long. */
function cleanWords(text: string | null | undefined): string {
  let t = (text ?? '').replace(/\d{8,}/g, '').replace(/[_|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // SHOUTING, or Every Word Capitalised: as a sentence.
  const words = t.split(' ');
  if (t === t.toUpperCase() || (words.length > 1 && words.filter((w) => w.length > 3).every((w) => !/^[a-z]/.test(w)))) t = t.toLowerCase();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

/** "Pune_Bhosari_H (Maharashtra)" → "Pune Bhosari, Maharashtra". */
export function cleanLocation(raw: string | null | undefined): string | null {
  const text = (raw ?? '').replace(/\d{6,}/g, '').trim();
  if (!text) return null;
  const state = /\(([^)]+)\)\s*$/.exec(text)?.[1]?.trim();
  const base = text
    .replace(/\([^)]*\)\s*$/, '')
    .split(/[_\s]+/)
    .filter((p) => p && !/^(H|D|DC|PC|HB|GW|IPC|RPC|L|HUB)$/i.test(p))
    .join(' ')
    .trim();
  const out = [base, state].filter(Boolean).join(', ');
  return out || null;
}

const FAILED_BY_WORDS: [RegExp, string][] = [
  [/refus|reject|not accept|did not want|doesn't want|cancel/i, 'The parcel was refused at the door'],
  [/unavailable|not available|not at home|nobody|no one|door ?lock|house ?lock|premises closed|office closed|shop closed|closed/i, 'Nobody was available to receive it'],
  [/address|incomplete|wrong|untraceable|not found|landmark|location/i, "The courier couldn't find the address"],
  [/not reachable|unreachable|not respond|switched off|not contactable|phone|call/i, "The courier couldn't reach you by phone"],
  [/future|reschedul|later date|another day|next day|defer/i, 'You asked for delivery on another day'],
  [/open delivery|open the|check the/i, 'You asked to open the parcel before accepting it'],
  [/cash|cod|amount|payment/i, 'The cash for delivery was not ready'],
  [/restrict|entry|security|gate|permission/i, "The courier couldn't get into the area"],
  [/self ?collect|collect from|pick ?up from branch/i, 'You chose to collect it from the courier'],
];
/** Delhivery's commonest failed-attempt codes, when the scan carries no words. */
const FAILED_BY_CODE: Record<string, string> = {
  'EOD-3': 'You asked for delivery on another day',
  'EOD-6': 'The parcel was refused at the door',
  'EOD-11': 'Nobody was available to receive it',
  'EOD-15': "The courier couldn't find the address",
  'EOD-43': "The courier couldn't reach you by phone",
  'EOD-69': 'You asked to open the parcel before accepting it',
  'EOD-74': "The courier couldn't find the address",
};

/** Why a delivery attempt failed, in simple words. */
export function failedAttemptReason(scan: Pick<TrackScanInput, 'code' | 'instructions' | 'status'> | null | undefined, fallback?: string | null): string {
  const text = `${scan?.instructions ?? ''} ${fallback ?? ''}`;
  for (const [rx, words] of FAILED_BY_WORDS) if (rx.test(text)) return words;
  const byCode = FAILED_BY_CODE[(scan?.code ?? '').toUpperCase()];
  if (byCode) return byCode;
  return cleanWords(scan?.instructions || fallback) || "The courier couldn't deliver it";
}

const isFailedAttempt = (s: TrackScanInput) => s.statusType.toUpperCase() === 'UD' && /^EOD-/i.test(s.code ?? '');
const isDispatched = (s: TrackScanInput) => s.statusType.toUpperCase() === 'UD' && s.status.trim().toLowerCase() === 'dispatched';
/** A parcel waiting somewhere for a reason: Delhivery's words say so. */
const HOLD_WORDS = /\bhold\b|\bheld\b|on hold|misrout|natural|weather|strike|curfew|restricted|regulatory|disturb/i;

/** One scan in plain words. */
export function describeScan(s: TrackScanInput): string {
  const type = s.statusType.toUpperCase();
  const status = s.status.trim().toLowerCase();
  const code = (s.code ?? '').toUpperCase();
  const words = cleanWords(s.instructions);
  if (status === 'lost') return 'Reported lost by the courier';
  if (type === 'CN' || status === 'canceled' || status === 'cancelled') return 'Shipment cancelled';
  if (type === 'DL') return status === 'rto' ? 'Returned to the seller' : status === 'dto' ? 'Return delivered to the seller' : 'Delivered';
  if (type === 'RT') return words ? `Returning to the seller — ${words}` : 'Returning to the seller';
  if (type === 'PP') return status === 'dispatched' ? 'Courier on the way to collect your return' : 'Return pickup scheduled';
  if (type === 'PU') return 'Return picked up — on its way to the seller';
  if (code === 'X-PNP' || status === 'not picked') return "The courier hasn't collected it from the seller yet";
  if (status === 'manifested' || status === 'open' || status === 'scheduled') return 'Shipping label created — waiting for the courier to collect it';
  if (isFailedAttempt(s)) return `Delivery attempt failed — ${failedAttemptReason(s)}`;
  if (status === 'dispatched') return 'Out for delivery';
  if (status === 'pending') return words ? `Waiting at the courier's hub — ${words}` : "Waiting at the courier's hub";
  return words || 'In transit';
}

export function scanViews(scans: TrackScanInput[]): TrackScanView[] {
  return [...scans]
    .filter((s) => !Number.isNaN(s.at.getTime()))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map((s) => ({ at: s.at.toISOString(), description: describeScan(s), location: cleanLocation(s.location) }));
}

// --- Money ---------------------------------------------------------------

export interface TrackRefundInput {
  status: string;
  amountPaise: number;
  processedAt: Date | null;
}

function rupees(paise: number): string {
  const r = paise / 100;
  return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Where the buyer's money is, in a sentence. */
export function refundWords(refund: TrackRefundInput | null, paymentMethod: string): string {
  if (!refund) return paymentMethod === 'COD' ? 'Nothing is due from you — it was Cash on Delivery.' : 'Anything you paid for it will be refunded in full.';
  const amount = rupees(refund.amountPaise);
  if (refund.status === 'PROCESSED') {
    return `Refund of ${amount} issued${refund.processedAt ? ` on ${trackDay(refund.processedAt)}` : ''}. Your bank may take 5–7 working days to show it.`;
  }
  if (refund.status === 'FAILED') return `Your refund of ${amount} didn't go through — we're sending it again. Contact support if it hasn't arrived in 7 days.`;
  return `Your refund of ${amount} is on its way (usually 5–7 working days).`;
}

// --- The parcel ------------------------------------------------------------

export interface TrackLineInput {
  status: string;
  packedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelReason: string | null;
  /** CUSTOMER | SELLER | ADMIN | PAYMENT_FAILED; null on lines cancelled before it was recorded. */
  cancelledBy: string | null;
  cancelledAt: Date | null;
}

export interface TrackShipmentInput {
  status: string;
  createdAt: Date;
  pickupFailedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  rtoInitiatedAt: Date | null;
  rtoDeliveredAt: Date | null;
  cancelledAt: Date | null;
  deliveryAttempts: number;
  courierPromisedAt: Date | null;
  etaTo: Date | null;
  lostFlaggedAt: Date | null;
  /** REPLACEMENT | REFUND, once the buyer has chosen. */
  lostChoice: string | null;
  rtoReason: string | null;
  statusText: string | null;
}

export interface ParcelTrackingInput {
  now: Date;
  placedAt: Date;
  paymentMethod: string;
  /** Placed, and the online payment has not gone through yet. */
  awaitingPayment: boolean;
  lines: TrackLineInput[];
  shipment: TrackShipmentInput | null;
  scans: TrackScanInput[];
  /** The seller's promise at checkout: the date first quoted. */
  promise: { deliveryBy: Date; deliveryByLatest: Date | null } | null;
  /** The order's own estimate, for orders from before per-seller promises. */
  orderEtaTo: Date | null;
  /** The refund for this parcel (a cancellation, a return to the seller, a lost parcel). */
  refund: TrackRefundInput | null;
}

const STEP_LABELS: Record<TrackStepKey, string> = {
  ORDERED: 'Ordered',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
};
const STEP_KEYS: TrackStepKey[] = ['ORDERED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];

/** How far a line has got, as a step index. */
const LINE_RANK: Record<string, number> = {
  PLACED: 0,
  CONFIRMED: 0,
  PACKED: 1,
  SHIPPED: 2,
  RTO_IN_TRANSIT: 2,
  RTO_DELIVERED: 2,
  DELIVERED: 4,
  RETURN_REQUESTED: 4,
  RETURNED: 4,
};
const SHIPMENT_RANK: Record<string, number> = {
  CREATED: 1,
  PICKUP_REQUESTED: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERY_FAILED: 3,
  DELIVERED: 4,
  RTO_IN_TRANSIT: 2,
  RTO_DELIVERED: 2,
  LOST: 2,
  CANCELLED: 1,
};

const earliest = (ds: (Date | null | undefined)[]) =>
  ds.filter((d): d is Date => !!d).reduce<Date | null>((m, d) => (!m || d < m ? d : m), null);
const latest = (ds: (Date | null | undefined)[]) =>
  ds.filter((d): d is Date => !!d).reduce<Date | null>((m, d) => (!m || d > m ? d : m), null);

function steps(reached: number, stamps: (Date | null)[], terminal: boolean): TrackStep<TrackStepKey>[] {
  return STEP_KEYS.map((key, i) => ({
    key,
    label: STEP_LABELS[key],
    at: i <= reached ? (stamps[i]?.toISOString() ?? null) : null,
    // Delivered, or stopped by something gone wrong: no step is "now".
    state: i < reached || (i === reached && (terminal || reached === STEP_KEYS.length - 1)) ? 'done' : i === reached ? 'current' : 'upcoming',
  }));
}

function cancelledException(lines: TrackLineInput[], refund: TrackRefundInput | null, paymentMethod: string): TrackException {
  const by = lines.find((l) => l.cancelledBy)?.cancelledBy ?? (lines.some((l) => l.cancelReason) ? 'SELLER_OR_ADMIN' : 'CUSTOMER');
  const reason = cleanWords(lines.find((l) => l.cancelReason)?.cancelReason);
  const title =
    by === 'CUSTOMER'
      ? 'You cancelled this'
      : by === 'SELLER'
        ? 'Cancelled by the seller'
        : by === 'ADMIN'
          ? 'Cancelled by Clowe'
          : by === 'PAYMENT_FAILED'
            ? "Cancelled — the payment didn't go through"
            : 'Cancelled by the seller or Clowe';
  if (by === 'PAYMENT_FAILED') {
    return { kind: 'CANCELLED', title, detail: refund ? refundWords(refund, paymentMethod) : 'Nothing was charged. If money left your account, it comes back automatically within 5–7 working days.', next: null };
  }
  return {
    kind: 'CANCELLED',
    title,
    detail: [reason ? `Reason: ${reason}.` : '', refundWords(refund, paymentMethod)].filter(Boolean).join(' '),
    next: null,
  };
}

export function buildParcelTracking(input: ParcelTrackingInput): ParcelTrackingCore {
  const { now, shipment: rawShipment, paymentMethod, refund } = input;
  const scans = [...input.scans].filter((s) => !Number.isNaN(s.at.getTime())).sort((a, b) => b.at.getTime() - a.at.getTime());
  const scanList = scanViews(scans);
  const live = input.lines.filter((l) => l.status !== 'CANCELLED');
  const allCancelled = live.length === 0;
  const lines = allCancelled ? input.lines : live;
  // A booking cancelled while its lines live on is being booked again: it says nothing.
  const shipment = rawShipment && !(rawShipment.status === 'CANCELLED' && !allCancelled) ? rawShipment : null;

  const lastDispatch = scans.find(isDispatched) ?? null;
  const lastFailed = scans.find(isFailedAttempt) ?? null;
  const delivered = lines.every((l) => l.status === 'DELIVERED' || l.status === 'RETURN_REQUESTED' || l.status === 'RETURNED') || shipment?.status === 'DELIVERED';

  // How far it got.
  let reached = Math.min(...lines.map((l) => LINE_RANK[l.status] ?? 0));
  if (shipment) reached = Math.max(reached, SHIPMENT_RANK[shipment.status] ?? 0);
  if (lastDispatch && !delivered && reached >= 2) reached = Math.max(reached, 3);
  if (delivered) reached = 4;
  if (allCancelled) reached = Math.max(0, Math.min(reached, shipment?.pickedUpAt ? 2 : shipment ? 1 : (LINE_RANK[lines[0]?.status ?? ''] ?? 0)));

  const shippedAt = shipment?.pickedUpAt ?? earliest(lines.map((l) => l.shippedAt));
  const deliveredAt = shipment?.deliveredAt ?? latest(lines.map((l) => l.deliveredAt));
  const stamps: (Date | null)[] = [
    input.placedAt,
    earliest(lines.map((l) => l.packedAt)) ?? (shipment ? shipment.createdAt : null) ?? shippedAt,
    shippedAt,
    lastDispatch?.at ?? null,
    deliveredAt,
  ];

  // The date to quote: Delhivery's own once it has one, else the estimate
  // from dispatch, else the seller's promise at checkout.
  const promised = input.promise ? (input.promise.deliveryByLatest ?? input.promise.deliveryBy) : null;
  const expected = shipment?.courierPromisedAt ?? (shippedAt ? shipment?.etaTo : null) ?? promised ?? input.orderEtaTo ?? null;
  const expectedAt = expected?.toISOString() ?? null;
  const base = { scans: scanList, expectedAt };

  // --- Not coming: cancelled, lost, going back --------------------------------
  // Lost first: once the buyer has chosen, its lines are closed (cancelled).
  if (shipment && (shipment.lostFlaggedAt || shipment.status === 'LOST')) {
    const detail =
      shipment.lostChoice === 'REPLACEMENT'
        ? 'A free replacement is on its way — see the replacement order.'
        : shipment.lostChoice === 'REFUND'
          ? refundWords(refund, paymentMethod)
          : 'We are sorry. Choose a free replacement or a full refund below.';
    return {
      ...base,
      expectedAt: null,
      chip: 'Lost',
      headline: 'Lost in transit',
      tone: 'danger',
      steps: steps(Math.min(reached, 3), stamps, true),
      exception: { kind: 'LOST', title: 'The courier lost this parcel', detail, next: null },
    };
  }
  if (allCancelled) {
    const at = latest(lines.map((l) => l.cancelledAt)) ?? shipment?.cancelledAt ?? null;
    return {
      ...base,
      expectedAt: null,
      chip: 'Cancelled',
      headline: at ? `Cancelled on ${trackDay(at)}` : 'Cancelled',
      tone: 'muted',
      steps: steps(reached, stamps, true),
      exception: cancelledException(lines, refund, paymentMethod),
    };
  }
  const rto = shipment?.status === 'RTO_IN_TRANSIT' || shipment?.status === 'RTO_DELIVERED' || lines.some((l) => l.status.startsWith('RTO_'));
  if (rto) {
    const back = shipment?.status === 'RTO_DELIVERED' || lines.every((l) => l.status === 'RTO_DELIVERED');
    const why = shipment?.rtoReason ? failedAttemptReason({ code: '', instructions: shipment.rtoReason, status: '' }) : null;
    return {
      ...base,
      expectedAt: null,
      chip: back ? 'Returned to seller' : 'Returning to seller',
      headline: back ? "Couldn't be delivered — returned to the seller" : "Couldn't be delivered — going back to the seller",
      tone: 'danger',
      steps: steps(Math.min(reached, lastDispatch ? 3 : 2), stamps, true),
      exception: {
        kind: 'RTO',
        title: back ? 'Returned to the seller' : 'On its way back to the seller',
        detail: [why ? `${why}.` : '', refundWords(refund, paymentMethod)].filter(Boolean).join(' '),
        next: 'Still want it? You can order it again.',
      },
    };
  }

  // --- Delivered -----------------------------------------------------------
  if (delivered) {
    return {
      ...base,
      expectedAt: null,
      chip: 'Delivered',
      headline: deliveredAt ? `Delivered on ${trackDayTime(deliveredAt)}` : 'Delivered',
      tone: 'success',
      steps: steps(4, stamps, false),
      exception: null,
    };
  }

  const stepList = steps(reached, stamps, false);

  if (input.awaitingPayment) {
    return { ...base, chip: 'Payment pending', headline: 'Waiting for your payment', tone: 'warning', steps: stepList, exception: null };
  }

  // --- On the road, something to say ------------------------------------------
  if (shipment?.status === 'DELIVERY_FAILED') {
    const attempt = Math.max(1, shipment.deliveryAttempts);
    const last = attempt >= MAX_DELIVERY_ATTEMPTS;
    const reason = failedAttemptReason(lastFailed, shipment.statusText);
    const refused = /refused/i.test(reason);
    return {
      ...base,
      chip: 'Attempt failed',
      headline: last ? 'Delivery failed — going back to the seller' : 'Delivery attempt failed — the courier will try again',
      tone: 'warning',
      steps: stepList,
      exception: {
        kind: 'FAILED_ATTEMPT',
        title: `Delivery attempt ${Math.min(attempt, MAX_DELIVERY_ATTEMPTS)} of ${MAX_DELIVERY_ATTEMPTS} failed${lastFailed ? ` on ${trackDayTime(lastFailed.at)}` : ''}`,
        detail: `${reason}.`,
        next: last
          ? `That was the last attempt: the parcel goes back to the seller. ${refundWords(refund, paymentMethod)}`
          : refused
            ? "If you don't want it, it goes back to the seller and you get a full refund. Changed your mind? Contact support and we'll ask the courier to try again."
            : 'Delhivery will try again, usually the next working day. Keep your phone handy — the courier calls before coming.',
      },
    };
  }

  if (shipment?.status === 'OUT_FOR_DELIVERY') {
    const today = lastDispatch && daysBetween(lastDispatch.at, now) === 0;
    return { ...base, chip: 'Out for delivery', headline: today ? 'Out for delivery today' : 'Out for delivery', tone: 'info', steps: stepList, exception: null };
  }

  // Delayed: Delhivery moved its date past the one we first quoted, or the
  // quoted day has gone by.
  let delay: TrackException | null = null;
  let headline: string | null = null;
  if (shipment?.courierPromisedAt && promised && daysBetween(promised, shipment.courierPromisedAt) > 0 && daysBetween(now, shipment.courierPromisedAt) >= 0) {
    headline = `Delayed — new expected date ${trackDay(shipment.courierPromisedAt)}`;
    delay = {
      kind: 'DELAYED',
      title: 'Running late',
      detail: `It was due by ${trackDay(promised)}. Delhivery now expects to deliver it ${relativeDay(shipment.courierPromisedAt, now)}.`,
      next: null,
    };
  } else if (expected && daysBetween(expected, now) > 0) {
    headline = `Delayed — it was due ${trackDay(expected)}`;
    delay = {
      kind: 'DELAYED',
      title: 'Running late',
      detail: `It was due by ${trackDay(expected)}. ${reached >= 2 ? "We're following it up with Delhivery." : "We've asked the seller to ship it."}`,
      next: 'We will update this page as soon as it moves.',
    };
  }

  const lastForward = scans.find((s) => s.statusType.toUpperCase() === 'UD') ?? null;
  const held =
    lastForward && !isFailedAttempt(lastForward) && !isDispatched(lastForward) && HOLD_WORDS.test(`${lastForward.instructions ?? ''} ${lastForward.status}`)
      ? lastForward
      : null;
  const notPicked = shipment && reached === 1 && shipment.pickupFailedAt;

  const exception: TrackException | null = held
    ? {
        kind: 'HELD',
        title: 'Held by the courier',
        detail: `${cleanWords(held.instructions) || 'The parcel is waiting at a courier hub'}${cleanLocation(held.location) ? ` (${cleanLocation(held.location)})` : ''}.`,
        next: 'It moves on once the hold clears — nothing is needed from you.',
      }
    : notPicked
      ? {
          kind: 'NOT_PICKED',
          title: "The courier hasn't collected it yet",
          detail: 'Delhivery missed the pickup from the seller. A new pickup has been asked for.',
          next: null,
        }
      : delay;

  if (headline) return { ...base, chip: 'Delayed', headline, tone: 'warning', steps: stepList, exception };

  const chip = reached >= 2 ? 'Arriving' : reached === 1 ? 'Packed' : 'Ordered';
  headline = expected ? `Arriving ${relativeDay(expected, now)}` : reached >= 2 ? 'On its way' : 'Preparing your order';
  if (expected && daysBetween(now, expected) === 0) headline = 'Arriving today';
  return { ...base, chip, headline, tone: exception ? 'warning' : 'info', steps: stepList, exception };
}

// --- Returns ----------------------------------------------------------------

export interface ReturnTrackingInput {
  returnId: string;
  itemTitle: string;
  rmaNumber: string;
  now: Date;
  status: string;
  createdAt: Date;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  pickedUpAt: Date | null;
  receivedAt: Date | null;
  /** REFUND | STORE_CREDIT | EXCHANGE | NONE */
  resolution: string;
  /** EXCHANGE | REFUND: what the buyer asked for. */
  remedy: string | null;
  selfShip: boolean;
  pickup: { status: string; createdAt: Date; pickedUpAt: Date | null; deliveredAt: Date | null; pickupFailedAt: Date | null } | null;
  pickupScans: TrackScanInput[];
  refund: TrackRefundInput | null;
  /** The exchange item went out: when it shipped (or the replacement order was placed). */
  exchangeShippedAt: Date | null;
  paymentMethod: string;
}

const RETURN_LABELS: Record<ReturnStepKey, string> = {
  REQUESTED: 'Return requested',
  PICKUP_SCHEDULED: 'Pickup scheduled',
  PICKED_UP: 'Picked up',
  RECEIVED: 'Received by seller',
  REFUNDED: 'Refund issued',
  EXCHANGE_SHIPPED: 'Exchange shipped',
};

export function buildReturnTracking(r: ReturnTrackingInput): ReturnTracking {
  const exchange = r.resolution === 'EXCHANGE' || r.remedy === 'EXCHANGE';
  const lastKey: ReturnStepKey = exchange ? 'EXCHANGE_SHIPPED' : 'REFUNDED';
  const keys: ReturnStepKey[] = ['REQUESTED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', lastKey];
  const scheduled = r.pickup ? r.pickup.createdAt : r.selfShip && r.approvedAt ? r.approvedAt : null;
  const pickedUp = r.pickedUpAt ?? r.pickup?.pickedUpAt ?? null;
  const received = r.receivedAt ?? r.pickup?.deliveredAt ?? null;
  const finished = exchange ? r.exchangeShippedAt : r.refund?.status === 'PROCESSED' ? (r.refund.processedAt ?? r.receivedAt) : null;
  const stamps = [r.createdAt, scheduled, pickedUp, received, finished];
  let reached = 0;
  stamps.forEach((d, i) => {
    if (d) reached = i;
  });
  if (r.status === 'REFUNDED' && !exchange) reached = 4;
  const rejected = r.status === 'REJECTED';
  const done = reached === 4;
  const stepList: TrackStep<ReturnStepKey>[] = keys.map((key, i) => ({
    key,
    label: key === 'PICKUP_SCHEDULED' && r.selfShip ? 'You send it' : RETURN_LABELS[key],
    at: i <= reached ? (stamps[i]?.toISOString() ?? null) : null,
    state: i < reached || (i === reached && (done || rejected)) ? 'done' : i === reached ? 'current' : 'upcoming',
  }));
  const common = { returnId: r.returnId, itemTitle: r.itemTitle, rmaNumber: r.rmaNumber, steps: stepList, scans: scanViews(r.pickupScans) };

  if (rejected) {
    return {
      ...common,
      chip: 'Return rejected',
      headline: 'Return not accepted',
      tone: 'muted',
      exception: {
        kind: 'RETURN_REJECTED',
        title: 'The seller did not accept this return',
        detail: cleanWords(r.rejectionReason) ? `Reason: ${cleanWords(r.rejectionReason)}.` : 'No reason was given.',
        next: 'Think this is wrong? Contact support and we will review it.',
      },
    };
  }
  if (done) {
    return exchange
      ? { ...common, chip: 'Exchanged', headline: `Exchange shipped${finished ? ` on ${trackDay(finished)}` : ''}`, tone: 'success', exception: null }
      : { ...common, chip: 'Refunded', headline: `Refund issued${finished ? ` on ${trackDay(finished)}` : ''}`, tone: 'success', exception: null };
  }
  if (r.pickup?.pickupFailedAt && !pickedUp) {
    return {
      ...common,
      chip: 'Pickup missed',
      headline: "Return pickup didn't happen",
      tone: 'warning',
      exception: {
        kind: 'PICKUP_FAILED',
        title: "The courier couldn't collect your return",
        detail: 'Keep the item packed. A new pickup will be booked, or we will tell you how to send it.',
        next: null,
      },
    };
  }
  if (received) {
    const refundLine = exchange ? 'Once it passes the check, your exchange item is sent.' : refundWords(r.refund, r.paymentMethod);
    return {
      ...common,
      chip: 'Received',
      headline: r.refund && !exchange ? 'Received by the seller — refund on its way' : 'Received by the seller — being checked',
      tone: 'info',
      exception: null,
      ...(r.refund?.status === 'FAILED' ? { tone: 'warning' as const, exception: { kind: 'RETURN_REJECTED' as const, title: 'Refund problem', detail: refundLine, next: null } } : {}),
    };
  }
  if (pickedUp) return { ...common, chip: 'Picked up', headline: 'Return picked up — on its way to the seller', tone: 'info', exception: null };
  if (scheduled) {
    return r.selfShip
      ? { ...common, chip: 'Send it', headline: 'Please send the item back to the seller', tone: 'info', exception: null }
      : { ...common, chip: 'Pickup scheduled', headline: `Pickup scheduled — the courier will collect it${r.pickup ? '' : ' soon'}`, tone: 'info', exception: null };
  }
  if (r.status === 'APPROVED') return { ...common, chip: 'Approved', headline: 'Return approved — booking the pickup', tone: 'info', exception: null };
  return { ...common, chip: 'Requested', headline: 'Return requested — the seller replies within 48 hours', tone: 'info', exception: null };
}

// --- The whole order, in one line -----------------------------------------

const TONE_ORDER: TrackTone[] = ['danger', 'warning', 'info', 'success', 'muted'];

/** What an order list shows: the parcel that most needs the buyer's eye. */
export function summarizeOrderTracking(parcels: Pick<ParcelTrackingCore, 'chip' | 'headline' | 'tone' | 'expectedAt'>[]): OrderTrackingSummary | null {
  if (parcels.length === 0) return null;
  const pick = [...parcels].sort((a, b) => {
    const t = TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone);
    if (t !== 0) return t;
    return (a.expectedAt ?? '9').localeCompare(b.expectedAt ?? '9');
  })[0]!;
  const delivered = parcels.filter((p) => p.tone === 'success').length;
  const suffix = parcels.length > 1 && pick.tone !== 'success' && delivered > 0 ? ` · ${delivered} of ${parcels.length} parcels delivered` : '';
  return { chip: pick.chip, headline: `${pick.headline}${suffix}`, tone: pick.tone };
}
