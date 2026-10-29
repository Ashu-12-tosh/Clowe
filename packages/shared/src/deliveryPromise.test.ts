import { describe, expect, it } from 'vitest';
import { addIstWorkingDays, deliveryPromise, istMidnightOf, promiseLabel, promiseStartDay } from './deliveryPromise';

/** An India-time moment, e.g. ist('2026-10-27 10:00'). */
const ist = (s: string) => new Date(`${s.replace(' ', 'T')}:00+05:30`);
/** The IST calendar day a promise lands on, as YYYY-MM-DD. */
const day = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

// The rule (owner, 29 Oct): processing starts today, or the next working day
// after the 14:00 cut-off → dispatched the same day (18 h promise) → picked up
// the next working day → + Delhivery's TAT → + 1 day; Sundays skipped only.

describe('deliveryPromise', () => {
  it('Thu 29 Oct 23:20 from 110053: dispatch Fri 30, pickup Sat 31, then TAT + 1 (Sun 1 Nov skipped)', () => {
    const now = ist('2026-10-29 23:20');
    const delhi = deliveryPromise({ now, tatDays: 2, destinationPincode: '110001' });
    expect(day(delhi.dispatchDay)).toBe('2026-10-30');
    expect(day(delhi.pickupDay)).toBe('2026-10-31');
    expect(day(delhi.deliveryBy)).toBe('2026-11-04'); // Mon 2, Tue 3 (TAT 2), Wed 4 (buffer)
    expect(day(deliveryPromise({ now, tatDays: 5, destinationPincode: '400001' }).deliveryBy)).toBe('2026-11-07');
    expect(day(deliveryPromise({ now, tatDays: 6, destinationPincode: '190001' }).deliveryBy)).toBe('2026-11-09');
    expect(delhi).toMatchObject({ source: 'DELHIVERY_TAT', deliveryByLatest: null });
  });

  it('before the cut-off: dispatched today, picked up tomorrow', () => {
    // Tue 27 Oct 10:00: dispatch Tue 27, pickup Wed 28; TAT 1 → Thu 29, buffer → Fri 30.
    const p = deliveryPromise({ now: ist('2026-10-27 10:00'), tatDays: 1, destinationPincode: '110001' });
    expect([day(p.dispatchDay), day(p.pickupDay), day(p.deliveryBy)]).toEqual(['2026-10-27', '2026-10-28', '2026-10-30']);
    expect(day(promiseStartDay(ist('2026-10-27 13:59')))).toBe('2026-10-27');
    expect(day(promiseStartDay(ist('2026-10-27 14:00')))).toBe('2026-10-28');
  });

  it('a Sunday order starts Monday; a Saturday one after the cut-off too, picked up Tuesday', () => {
    expect(day(promiseStartDay(ist('2026-10-25 09:00')))).toBe('2026-10-26');
    const sat = deliveryPromise({ now: ist('2026-10-31 16:00'), tatDays: 1, destinationPincode: '110001' });
    expect([day(sat.dispatchDay), day(sat.pickupDay), day(sat.deliveryBy)]).toEqual(['2026-11-02', '2026-11-03', '2026-11-05']);
  });

  it('counts long TATs in working days (Port Blair, 11)', () => {
    // Tue 27 Oct 10:00: pickup Wed 28, then 12 working days.
    expect(day(deliveryPromise({ now: ist('2026-10-27 10:00'), tatDays: 11, destinationPincode: '744101' }).deliveryBy)).toBe('2026-11-11');
  });

  it('falls back to the zone range from the pickup day when there is no TAT', () => {
    // Metro 2–4 transit days from a Wed 28 pickup, plus the buffer: Sat 31 Oct – Tue 3 Nov.
    const p = deliveryPromise({ now: ist('2026-10-27 10:00'), tatDays: null, destinationPincode: '400001' });
    expect(p.source).toBe('ZONE');
    expect(day(p.deliveryBy)).toBe('2026-10-31');
    expect(day(p.deliveryByLatest!)).toBe('2026-11-03');
    expect(promiseLabel(p)).toBe('Delivery by Sat, 31 Oct – Tue, 3 Nov');
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
