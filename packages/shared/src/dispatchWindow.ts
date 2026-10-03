import { z } from 'zod';

// ---------------------------------------------------------------------------
// Dispatch rules
//
// Two clocks start when an order is placed, both from platform settings:
//
//   - the dispatch promise (dispatchSlaHours): what sellers are asked to
//     meet, shown on every unshipped order;
//   - the penalty deadline (lateDispatchPenaltyAfterHours): later than the
//     promise. A seller whose part of an order has not left by then is
//     charged once for that order, whether it ships later or never.
//
// Both are wall-clock and do not stop overnight: the shopper was promised the
// time, not the seller's working day, and the admin's waiver exists for the
// case where that is unfair. Vacation mode is the one thing that stops the
// penalty clock.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** When the dispatch promise for an order placed at `placedAt` runs out. */
export function dispatchSlaDeadline(placedAt: Date, slaHours: number): Date {
  return new Date(placedAt.getTime() + slaHours * HOUR_MS);
}

/** The seller's most recent vacation, as recorded when it was switched on and off. */
export interface VacationSpan {
  startedAt: Date | null;
  /** Null while the seller is still on vacation. */
  endedAt: Date | null;
}

/**
 * When the late-dispatch penalty falls due. A vacation that began before the
 * deadline stops the clock for as long as it lasted (from placement, if the
 * order came in first); while it is still on there is no deadline at all.
 */
export function penaltyDeadline(
  placedAt: Date,
  afterHours: number,
  vacation: VacationSpan | null = null,
): Date | null {
  const base = placedAt.getTime() + afterHours * HOUR_MS;
  if (!vacation?.startedAt || vacation.startedAt.getTime() >= base) return new Date(base);
  if (!vacation.endedAt) return null;
  const pausedFrom = Math.max(vacation.startedAt.getTime(), placedAt.getTime());
  const paused = Math.max(0, vacation.endedAt.getTime() - pausedFrom);
  return new Date(base + paused);
}

/** One of a seller's lines on an order, as far as dispatch is concerned. */
export interface DispatchLine {
  status: string;
  shippedAt: Date | null;
}

/** Lines the seller can still dispatch. PLACED is an order still awaiting payment. */
const AWAITING_DISPATCH = new Set(['CONFIRMED', 'PACKED']);

/**
 * Is the seller's part of an order late at `now`? Late when any line left
 * after the deadline, or has still not left once it has passed. Cancelled
 * lines and lines awaiting payment are not the seller's to dispatch.
 */
export function isOrderDispatchLate(lines: DispatchLine[], deadline: Date | null, now: Date): boolean {
  if (!deadline) return false;
  const due = deadline.getTime();
  return lines.some((l) => {
    if (l.status === 'CANCELLED') return false;
    if (l.shippedAt) return l.shippedAt.getTime() > due;
    return AWAITING_DISPATCH.has(l.status) && now.getTime() > due;
  });
}

/** Whole and fractional hours between placement and `at`. */
export function hoursSincePlacement(placedAt: Date, at: Date): number {
  return (at.getTime() - placedAt.getTime()) / HOUR_MS;
}

/** "4h 12m" / "2h" / "35m" — never negative, never seconds. */
export function formatHoursMinutes(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * What the penalty entry says, so the seller can see the arithmetic:
 * "Dispatched 30h after placement; penalty after 24h" or "Not dispatched
 * within 24h of placement", plus any time the clock stood still.
 */
export function lateDispatchNote(input: {
  placedAt: Date;
  /** When the late line left, or null when it had not left at all. */
  shippedAt: Date | null;
  afterHours: number;
  /** Hours the clock was paused for vacation. */
  pausedHours?: number;
}): string {
  const paused = input.pausedHours && input.pausedHours > 0 ? `, plus ${Math.round(input.pausedHours)}h paused for vacation` : '';
  if (!input.shippedAt) return `Not dispatched within ${input.afterHours}h of placement${paused}`;
  const hours = hoursSincePlacement(input.placedAt, input.shippedAt);
  const shown = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return `Dispatched ${shown}h after placement; penalty after ${input.afterHours}h${paused}`;
}

/** The two clocks for a seller's unshipped order, as the API sends them. */
export interface SellerDispatchClock {
  /** When the dispatch promise runs out. */
  dispatchBy: string;
  /** When the penalty falls due; null while vacation pauses it or penalties are off. */
  penaltyAt: string | null;
  penaltyEnabled: boolean;
  /** True while the seller is on vacation and the penalty clock is stopped. */
  penaltyPaused: boolean;
  /** A penalty has been charged for this order. */
  penaltyCharged: boolean;
}

export interface DispatchCountdownView {
  dispatch: { late: boolean; label: string };
  /** Null when penalties are switched off. */
  penalty: { state: 'COUNTING' | 'DUE' | 'PAUSED' | 'CHARGED'; label: string } | null;
}

/**
 * The chips a seller sees on an unshipped order: "Dispatch within 6h 12m"
 * and "Penalty after 12h 12m"; once missed, "Dispatch promise missed by 1h"
 * and "Late by 203h · penalty charged".
 */
export function dispatchCountdown(clock: SellerDispatchClock, now: Date): DispatchCountdownView {
  const toPromise = new Date(clock.dispatchBy).getTime() - now.getTime();
  const dispatch =
    toPromise >= 0
      ? { late: false, label: `Dispatch within ${formatHoursMinutes(toPromise)}` }
      : { late: true, label: `Dispatch promise missed by ${formatHoursMinutes(-toPromise)}` };

  if (!clock.penaltyEnabled && !clock.penaltyCharged) return { dispatch, penalty: null };
  if (clock.penaltyPaused) return { dispatch, penalty: { state: 'PAUSED', label: 'Penalty paused while on vacation' } };
  if (!clock.penaltyAt) return { dispatch, penalty: null };
  const toPenalty = new Date(clock.penaltyAt).getTime() - now.getTime();
  if (toPenalty >= 0) {
    return { dispatch, penalty: { state: 'COUNTING', label: `Penalty after ${formatHoursMinutes(toPenalty)}` } };
  }
  const late = `Late by ${formatHoursMinutes(-toPenalty)}`;
  return clock.penaltyCharged
    ? { dispatch, penalty: { state: 'CHARGED', label: `${late} · penalty charged` } }
    : { dispatch, penalty: { state: 'DUE', label: `${late} · penalty due` } };
}

export const ledgerWaiveSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason (min 5 chars)').max(300),
});
export type LedgerWaiveInput = z.infer<typeof ledgerWaiveSchema>;
