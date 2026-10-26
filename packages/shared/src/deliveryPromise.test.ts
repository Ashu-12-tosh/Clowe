import { describe, expect, it } from 'vitest';
import { addIstWorkingDays, deliveryPromise, istMidnightOf, promiseLabel, promiseStartDay } from './deliveryPromise';

/** An India-time moment, e.g. ist('2026-10-27 10:00'). */
const ist = (s: string) => new Date(`${s.replace(' ', 'T')}:00+05:30`);
/** The IST calendar day a promise lands on, as YYYY-MM-DD. */
const day = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

describe('deliveryPromise', () => {
  it('counts dispatch, Delhivery TAT and a day of buffer in working days from an order before the cut-off', () => {
    // Tue 27 Oct, 10:00: starts today; dispatch Thu 29 (2 days); 1 day transit + 1 buffer → Sat 31.
    const p = deliveryPromise({ now: ist('2026-10-27 10:00'), dispatchDays: 2, tatDays: 1, destinationPincode: '110001' });
    expect(day(p.deliveryBy)).toBe('2026-10-31');
    expect(p.deliveryByLatest).toBeNull();
    expect(p.source).toBe('DELHIVERY_TAT');
  });

  it('starts from the next working day after the 14:00 cut-off, and skips Sundays', () => {
    // Tue 15:00 → starts Wed 28; dispatch Fri 30; +2 → Mon 2 Nov (Sunday skipped).
    const p = deliveryPromise({ now: ist('2026-10-27 15:00'), dispatchDays: 2, tatDays: 1, destinationPincode: '110001' });
    expect(day(p.deliveryBy)).toBe('2026-11-02');
    expect(day(promiseStartDay(ist('2026-10-27 13:59')))).toBe('2026-10-27');
    expect(day(promiseStartDay(ist('2026-10-27 14:00')))).toBe('2026-10-28');
  });

  it('starts a Sunday order on Monday', () => {
    expect(day(promiseStartDay(ist('2026-10-25 09:00')))).toBe('2026-10-26');
    // A Saturday after the cut-off goes to Monday as well.
    expect(day(promiseStartDay(ist('2026-10-31 16:00')))).toBe('2026-11-02');
  });

  it('uses the real TATs from 110053 (Mumbai 5, Srinagar 6, Port Blair 11)', () => {
    const now = ist('2026-10-27 10:00'); // dispatch Thu 29
    expect(day(deliveryPromise({ now, dispatchDays: 2, tatDays: 5, destinationPincode: '400001' }).deliveryBy)).toBe('2026-11-05');
    expect(day(deliveryPromise({ now, dispatchDays: 2, tatDays: 6, destinationPincode: '190001' }).deliveryBy)).toBe('2026-11-06');
    expect(day(deliveryPromise({ now, dispatchDays: 2, tatDays: 11, destinationPincode: '744101' }).deliveryBy)).toBe('2026-11-12');
  });

  it('falls back to the zone range when there is no TAT', () => {
    // Metro 2–4 transit days from Thu 29 dispatch, plus the buffer: Mon 2 – Wed 4 Nov.
    const p = deliveryPromise({ now: ist('2026-10-27 10:00'), dispatchDays: 2, tatDays: null, destinationPincode: '400001' });
    expect(p.source).toBe('ZONE');
    expect(day(p.deliveryBy)).toBe('2026-11-02');
    expect(day(p.deliveryByLatest!)).toBe('2026-11-04');
    expect(promiseLabel(p)).toBe('Delivery by Mon, 2 Nov – Wed, 4 Nov');
  });

  it('reads one day as "Delivery by <day, date>"', () => {
    expect(promiseLabel({ deliveryBy: ist('2026-10-31 00:00'), deliveryByLatest: null })).toBe('Delivery by Sat, 31 Oct');
  });

  it('keeps days in India time near midnight UTC', () => {
    // 23:30 UTC on the 26th is 05:00 IST on the 27th.
    expect(day(istMidnightOf(new Date('2026-10-26T23:30:00Z')))).toBe('2026-10-27');
    expect(day(addIstWorkingDays(ist('2026-10-31 00:00'), 1))).toBe('2026-11-02');
  });
});
