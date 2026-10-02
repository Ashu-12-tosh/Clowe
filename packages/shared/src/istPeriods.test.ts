import { describe, expect, it } from 'vitest';
import {
  istDate,
  istDayKey,
  istDayStart,
  istFinancialYear,
  istMonthStart,
  istStartOfDay,
  monthPeriodIST,
  monthToDateIST,
  periodToDateIST,
} from './istPeriods';

describe('the Indian calendar', () => {
  it('starts a day at 00:00 IST, which is 18:30 UTC the evening before', () => {
    expect(istDayStart(2026, 9, 1).toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('reads 20:00 UTC on the 31st as the 1st in India', () => {
    expect(istDate(new Date('2026-10-31T20:00:00Z'))).toEqual({ year: 2026, month: 10, day: 1 });
  });

  it('turns the day, and the day key, at 18:30 UTC', () => {
    expect(istDayKey(new Date('2026-09-30T18:29:59.999Z'))).toBe('2026-09-30');
    expect(istDayKey(new Date('2026-09-30T18:30:00.000Z'))).toBe('2026-10-01');
    expect(istStartOfDay(new Date('2026-10-01T02:00:00Z')).toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('finds the start of this month and of the months around it', () => {
    const at = new Date('2026-10-31T20:00:00Z'); // 1 Nov, 01:30 IST
    expect(istMonthStart(at).toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(istMonthStart(at, -1).toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });
});

describe('periodToDateIST', () => {
  it('compares today so far with yesterday to the same time', () => {
    const p = periodToDateIST('day', new Date('2026-10-04T04:30:00Z')); // 10:00 IST
    expect(p.from.toISOString()).toBe('2026-10-03T18:30:00.000Z');
    expect(p.previousFrom.toISOString()).toBe('2026-10-02T18:30:00.000Z');
    expect(p.previousTo.toISOString()).toBe('2026-10-03T04:30:00.000Z');
  });

  it('compares this year so far with the same days of last year', () => {
    const p = periodToDateIST('year', new Date('2026-10-04T04:30:00Z'));
    expect(p.from.toISOString()).toBe('2025-12-31T18:30:00.000Z'); // 1 Jan 2026 IST
    expect(p.previousFrom.toISOString()).toBe('2024-12-31T18:30:00.000Z'); // 1 Jan 2025 IST
    expect(p.previousTo.toISOString()).toBe('2025-10-04T04:30:00.000Z');
  });
});

describe('monthPeriodIST', () => {
  const now = new Date('2026-10-04T04:30:00Z');

  it('compares the month still running with the same days of the month before', () => {
    const p = monthPeriodIST(undefined, now);
    expect(p.running).toBe(true);
    expect(p.to).toEqual(now);
    expect(p.previousTo.toISOString()).toBe('2026-09-04T04:30:00.000Z');
    expect(p.monthEnd.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it('compares a finished month whole with the whole month before', () => {
    const p = monthPeriodIST('2026-09', now);
    expect(p.running).toBe(false);
    expect([p.from, p.to, p.previousFrom, p.previousTo].map((d) => d.toISOString())).toEqual([
      '2026-08-31T18:30:00.000Z',
      '2026-09-30T18:30:00.000Z',
      '2026-07-31T18:30:00.000Z',
      '2026-08-31T18:30:00.000Z',
    ]);
  });

  it('ignores a month that is not one', () => {
    expect(monthPeriodIST('2026-13', now).running).toBe(true);
  });
});

describe('istFinancialYear', () => {
  it('runs from 1 April 00:00 IST, and 31 March 23:00 IST is still the year before', () => {
    expect(istFinancialYear(new Date('2027-03-31T17:30:00Z'))).toMatchObject({ label: '2026-27' });
    const fy = istFinancialYear(new Date('2027-03-31T18:30:00Z')); // 1 Apr 2027, 00:00 IST
    expect(fy.label).toBe('2027-28');
    expect(fy.from.toISOString()).toBe('2027-03-31T18:30:00.000Z');
    expect(fy.to.toISOString()).toBe('2028-03-31T18:30:00.000Z');
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
