// ---------------------------------------------------------------------------
// Calendar periods by the Indian clock.
//
// Sellers read "this month" as a month in India, whatever timezone the server
// runs in. IST is UTC+5:30 all year (no daylight saving), so a fixed offset is
// exact.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Year, month (0-11) and day of an instant on an Indian calendar. */
export function istDate(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/** The instant an Indian calendar day starts. Month may run past 0-11; it rolls into the next or previous year. */
export function istDayStart(year: number, month: number, day = 1): Date {
  return new Date(Date.UTC(year, month, day) - IST_OFFSET_MS);
}

export interface MonthToDate {
  /** This month so far: from the 1st (IST) to now. */
  from: Date;
  to: Date;
  /** The same stretch of last month: from its 1st, as long as this month has run, never past its end. */
  previousFrom: Date;
  previousTo: Date;
}

/** A period and the one it is compared with, as sent to the UI so it can name both. */
export interface PeriodWindow {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

export function periodWindow(p: { from: Date; to: Date; previousFrom: Date; previousTo: Date }): PeriodWindow {
  return {
    from: p.from.toISOString(),
    to: p.to.toISOString(),
    previousFrom: p.previousFrom.toISOString(),
    previousTo: p.previousTo.toISOString(),
  };
}

/** This month so far, and the same span of last month to compare it with. */
export function monthToDateIST(now: Date): MonthToDate {
  return periodToDateIST('month', now);
}

export type CalendarUnit = 'day' | 'month' | 'year';

/**
 * This day, month or year so far, and the same elapsed span of the one before
 * it: today to now against yesterday to the same time, 1–4 Oct against 1–4
 * Sep, 1 Jan–4 Oct against the same days of last year. The earlier span never
 * runs past its own end (31 Mar against a 30-day February stops at 28 Feb).
 */
export function periodToDateIST(unit: CalendarUnit, now: Date): MonthToDate {
  const { year, month, day } = istDate(now);
  const start = (back: number): Date =>
    unit === 'day'
      ? istDayStart(year, month, day - back)
      : unit === 'month'
        ? istDayStart(year, month - back)
        : istDayStart(year - back, 0);
  const from = start(0);
  const previousFrom = start(1);
  const elapsed = now.getTime() - from.getTime();
  const previousTo = new Date(Math.min(previousFrom.getTime() + elapsed, from.getTime()));
  return { from, to: now, previousFrom, previousTo };
}

/** The instant the Indian calendar day holding `at` began. */
export function istStartOfDay(at: Date): Date {
  const { year, month, day } = istDate(at);
  return istDayStart(year, month, day);
}

/** The instant the Indian calendar month holding `at` began, or one `offset` months away. */
export function istMonthStart(at: Date, offset = 0): Date {
  const { year, month } = istDate(at);
  return istDayStart(year, month + offset);
}

/** "2026-10-04": the Indian calendar date of an instant, for day buckets and exports. */
export function istDayKey(at: Date): string {
  const { year, month, day } = istDate(at);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface MonthPeriod {
  from: Date;
  /** Exclusive: now for the month still running, else the next month's start. */
  to: Date;
  previousFrom: Date;
  /** Exclusive. */
  previousTo: Date;
  /** Exclusive end of the whole month, for a series that covers every day of it. */
  monthEnd: Date;
  /** The month is still running, so it is compared with the same days of the one before. */
  running: boolean;
}

/**
 * A calendar month, "YYYY-MM" (default: this one), against the month before.
 * A finished month is compared whole with the whole month before; the month
 * still running, with the same days of the one before.
 */
export function monthPeriodIST(month: string | undefined, now: Date): MonthPeriod {
  const parsed = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month.split('-').map(Number) : null;
  const year = parsed ? parsed[0] : istDate(now).year;
  const index = parsed ? parsed[1] - 1 : istDate(now).month;
  const from = istDayStart(year, index);
  const monthEnd = istDayStart(year, index + 1);
  if (now >= from && now < monthEnd) {
    const mtd = monthToDateIST(now);
    return { ...mtd, monthEnd, running: true };
  }
  return { from, to: monthEnd, previousFrom: istDayStart(year, index - 1), previousTo: from, monthEnd, running: false };
}

/** The Indian financial year (April–March) holding `at`, e.g. "2026-27"; `to` is exclusive. */
export function istFinancialYear(at: Date): { label: string; from: Date; to: Date } {
  const { year, month } = istDate(at);
  const start = month >= 3 ? year : year - 1;
  return {
    label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`,
    from: istDayStart(start, 3),
    to: istDayStart(start + 1, 3),
  };
}
