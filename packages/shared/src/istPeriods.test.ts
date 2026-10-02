import { describe, expect, it } from 'vitest';
import { istDate, istDayStart, monthToDateIST } from './istPeriods';

describe('the Indian calendar', () => {
  it('starts a day at 00:00 IST, which is 18:30 UTC the evening before', () => {
    expect(istDayStart(2026, 9, 1).toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('reads 20:00 UTC on the 31st as the 1st in India', () => {
    expect(istDate(new Date('2026-10-31T20:00:00Z'))).toEqual({ year: 2026, month: 10, day: 1 });
  });
});

describe('monthToDateIST', () => {
  it('compares the first days of this month with the same days of last month', () => {
    // 4 Oct 2026, 10:00 IST.
    const p = monthToDateIST(new Date('2026-10-04T04:30:00Z'));
    expect(p.from.toISOString()).toBe('2026-09-30T18:30:00.000Z'); // 1 Oct 00:00 IST
    expect(p.previousFrom.toISOString()).toBe('2026-08-31T18:30:00.000Z'); // 1 Sep 00:00 IST
    expect(p.previousTo.toISOString()).toBe('2026-09-04T04:30:00.000Z'); // 4 Sep 10:00 IST
  });

  it('counts an evening order on the last of the month in that month, by Indian time', () => {
    // 31 Oct 2026, 23:00 IST is still October in India, though 1 Nov is not far off in UTC terms.
    const p = monthToDateIST(new Date('2026-10-31T17:30:00Z'));
    expect(p.from.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('never runs last month past its end (31 March against February)', () => {
    const p = monthToDateIST(new Date('2027-03-31T12:00:00Z'));
    expect(p.previousFrom.toISOString()).toBe('2027-01-31T18:30:00.000Z'); // 1 Feb IST
    expect(p.previousTo.toISOString()).toBe('2027-02-28T18:30:00.000Z'); // 1 Mar 00:00 IST: all of February
  });

  it('crosses the year in January', () => {
    const p = monthToDateIST(new Date('2027-01-10T00:00:00Z'));
    expect(p.previousFrom.toISOString()).toBe('2026-11-30T18:30:00.000Z'); // 1 Dec 2026 IST
  });
});
