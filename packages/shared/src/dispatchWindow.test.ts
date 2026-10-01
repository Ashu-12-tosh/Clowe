import { describe, expect, it } from 'vitest';
import {
  dispatchCountdown,
  dispatchDeadline,
  formatHoursMinutes,
  isLateDispatch,
  lateDispatchNote,
} from './dispatchWindow';

const placed = new Date('2026-10-01T23:00:00.000Z');
const h = (n: number) => new Date(placed.getTime() + n * 3_600_000);

describe('the dispatch window', () => {
  it('ends exactly windowHours after placement, overnight included', () => {
    // 11pm + 12h is 11am. The clock does not stop for the night.
    expect(dispatchDeadline(placed, 12).toISOString()).toBe('2026-10-02T11:00:00.000Z');
  });

  it('is on time up to and including the deadline', () => {
    expect(isLateDispatch(placed, h(11.9), 12)).toBe(false);
    expect(isLateDispatch(placed, h(12), 12)).toBe(false);
    expect(isLateDispatch(placed, h(12.001), 12)).toBe(true);
  });

  it('follows the window it is given', () => {
    expect(isLateDispatch(placed, h(20), 24)).toBe(false);
    expect(isLateDispatch(placed, h(20), 12)).toBe(true);
  });
});

describe('what the seller is told', () => {
  it('counts down while there is time', () => {
    const c = dispatchCountdown(placed, h(7.8), 12);
    expect(c.late).toBe(false);
    expect(c.label).toBe('Dispatch within 4h 12m');
  });

  it('counts up once late', () => {
    const c = dispatchCountdown(placed, h(14), 12);
    expect(c.late).toBe(true);
    expect(c.label).toBe('Late by 2h');
  });

  it('writes the penalty note with the arithmetic in it', () => {
    expect(lateDispatchNote(placed, h(14), 12)).toBe('Dispatched 14h after placement; window 12h');
    expect(lateDispatchNote(placed, h(3.25), 2)).toBe('Dispatched 3.3h after placement; window 2h');
  });

  it('never shows seconds or negatives', () => {
    expect(formatHoursMinutes(-5_000)).toBe('0m');
    expect(formatHoursMinutes(59_000)).toBe('1m');
    expect(formatHoursMinutes(3_600_000)).toBe('1h');
  });
});
