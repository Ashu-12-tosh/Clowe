import { z } from 'zod';

// ---------------------------------------------------------------------------
// Dispatch window
//
// A seller has `windowHours` from the moment an order is placed to mark it
// shipped. The clock is wall-clock and does not pause overnight: an order
// placed at 11pm with a 12-hour window is due at 11am. That is deliberate —
// the shopper was promised the window, not the seller's working day — and
// the admin's waiver exists for exactly the case where that is unfair.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** When a line placed at `placedAt` must be shipped by. */
export function dispatchDeadline(placedAt: Date, windowHours: number): Date {
  return new Date(placedAt.getTime() + windowHours * HOUR_MS);
}

/** Whole and fractional hours between placement and the moment it shipped. */
export function hoursSincePlacement(placedAt: Date, shippedAt: Date): number {
  return (shippedAt.getTime() - placedAt.getTime()) / HOUR_MS;
}

/** True when a line shipped at `shippedAt` missed the window. */
export function isLateDispatch(placedAt: Date, shippedAt: Date, windowHours: number): boolean {
  return shippedAt.getTime() > dispatchDeadline(placedAt, windowHours).getTime();
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

/** What the penalty entry says, so the seller can see the arithmetic. */
export function lateDispatchNote(placedAt: Date, shippedAt: Date, windowHours: number): string {
  const hours = hoursSincePlacement(placedAt, shippedAt);
  const shown = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return `Dispatched ${shown}h after placement; window ${windowHours}h`;
}

export interface DispatchCountdown {
  late: boolean;
  /** "Dispatch within 4h 12m" or "Late by 2h". */
  label: string;
  deadline: Date;
}

/** The chip a seller sees on an unshipped line. */
export function dispatchCountdown(placedAt: Date, now: Date, windowHours: number): DispatchCountdown {
  const deadline = dispatchDeadline(placedAt, windowHours);
  const remaining = deadline.getTime() - now.getTime();
  if (remaining < 0) {
    return { late: true, label: `Late by ${formatHoursMinutes(-remaining)}`, deadline };
  }
  return { late: false, label: `Dispatch within ${formatHoursMinutes(remaining)}`, deadline };
}

export const ledgerWaiveSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason (min 5 chars)').max(300),
});
export type LedgerWaiveInput = z.infer<typeof ledgerWaiveSchema>;
