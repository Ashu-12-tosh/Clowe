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

/** This month so far, and the same span of last month to compare it with. */
export function monthToDateIST(now: Date): MonthToDate {
  const { year, month } = istDate(now);
  const from = istDayStart(year, month);
  const previousFrom = istDayStart(year, month - 1);
  const elapsed = now.getTime() - from.getTime();
  const previousTo = new Date(Math.min(previousFrom.getTime() + elapsed, from.getTime()));
  return { from, to: now, previousFrom, previousTo };
}
