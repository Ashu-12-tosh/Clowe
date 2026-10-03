import { describe, expect, it } from 'vitest';
import {
  dispatchCountdown,
  dispatchSlaDeadline,
  formatHoursMinutes,
  isOrderDispatchLate,
  lateDispatchNote,
  penaltyDeadline,
  type SellerDispatchClock,
} from './dispatchWindow';

const placed = new Date('2026-10-01T23:00:00.000Z');
const h = (n: number) => new Date(placed.getTime() + n * 3_600_000);

describe('the dispatch promise', () => {
  it('ends exactly slaHours after placement, overnight included', () => {
    // 11pm + 18h is 5pm. The clock does not stop for the night.
    expect(dispatchSlaDeadline(placed, 18).toISOString()).toBe('2026-10-02T17:00:00.000Z');
  });
});

describe('the penalty deadline', () => {
  it('is afterHours after placement with no vacation', () => {
    expect(penaltyDeadline(placed, 24)).toEqual(h(24));
  });

  it('does not exist while the seller is on a vacation that began before it', () => {
    expect(penaltyDeadline(placed, 24, { startedAt: h(10), endedAt: null })).toBeNull();
  });

  it('moves by however long the vacation stopped the clock', () => {
    // Away from hour 10 to hour 18: eight hours paused, so due at 32.
    expect(penaltyDeadline(placed, 24, { startedAt: h(10), endedAt: h(18) })).toEqual(h(32));
    // A vacation already on when the order came in counts from placement.
    expect(penaltyDeadline(placed, 24, { startedAt: h(-5), endedAt: h(3) })).toEqual(h(27));
  });

  it('ignores a vacation that ended before the order or began after the deadline', () => {
    expect(penaltyDeadline(placed, 24, { startedAt: h(-20), endedAt: h(-2) })).toEqual(h(24));
    expect(penaltyDeadline(placed, 24, { startedAt: h(30), endedAt: null })).toEqual(h(24));
  });
});

describe('a late order', () => {
  const due = h(24);

  it('is on time when every line left by the deadline, even past the promise', () => {
    const lines = [{ status: 'SHIPPED', shippedAt: h(20) }, { status: 'DELIVERED', shippedAt: h(23.9) }];
    expect(isOrderDispatchLate(lines, due, h(100))).toBe(false);
  });

  it('is late when any line left after it', () => {
    const lines = [{ status: 'SHIPPED', shippedAt: h(2) }, { status: 'SHIPPED', shippedAt: h(25) }];
    expect(isOrderDispatchLate(lines, due, h(26))).toBe(true);
  });

  it('is late once the deadline passes with a line still not dispatched', () => {
    const lines = [{ status: 'CONFIRMED', shippedAt: null }];
    expect(isOrderDispatchLate(lines, due, h(23))).toBe(false);
    expect(isOrderDispatchLate(lines, due, h(24.01))).toBe(true);
    expect(isOrderDispatchLate([{ status: 'PACKED', shippedAt: null }], due, h(203))).toBe(true);
  });

  it('does not count cancelled lines, lines awaiting payment, or a paused clock', () => {
    expect(isOrderDispatchLate([{ status: 'CANCELLED', shippedAt: null }], due, h(100))).toBe(false);
    expect(isOrderDispatchLate([{ status: 'PLACED', shippedAt: null }], due, h(100))).toBe(false);
    expect(isOrderDispatchLate([{ status: 'CONFIRMED', shippedAt: null }], null, h(100))).toBe(false);
  });
});

describe('what the seller is told', () => {
  it('shows the arithmetic in the penalty note', () => {
    expect(lateDispatchNote({ placedAt: placed, shippedAt: h(30), afterHours: 24 })).toBe(
      'Dispatched 30h after placement; penalty after 24h',
    );
    expect(lateDispatchNote({ placedAt: placed, shippedAt: null, afterHours: 24 })).toBe(
      'Not dispatched within 24h of placement',
    );
    expect(lateDispatchNote({ placedAt: placed, shippedAt: null, afterHours: 24, pausedHours: 8 })).toBe(
      'Not dispatched within 24h of placement, plus 8h paused for vacation',
    );
  });

  const clock = (over: Partial<SellerDispatchClock> = {}): SellerDispatchClock => ({
    dispatchBy: h(18).toISOString(),
    penaltyAt: h(24).toISOString(),
    penaltyEnabled: true,
    penaltyPaused: false,
    penaltyCharged: false,
    ...over,
  });

  it('counts down to both the promise and the penalty', () => {
    const view = dispatchCountdown(clock(), placed);
    expect(view.dispatch).toEqual({ late: false, label: 'Dispatch within 18h' });
    expect(view.penalty).toEqual({ state: 'COUNTING', label: 'Penalty after 24h' });
  });

  it('says the promise was missed while the penalty is still ahead', () => {
    const view = dispatchCountdown(clock(), h(19));
    expect(view.dispatch).toEqual({ late: true, label: 'Dispatch promise missed by 1h' });
    expect(view.penalty?.label).toBe('Penalty after 5h');
  });

  it('says when the penalty is due, charged, paused, or off', () => {
    expect(dispatchCountdown(clock(), h(227)).penalty).toEqual({ state: 'DUE', label: 'Late by 203h · penalty due' });
    expect(dispatchCountdown(clock({ penaltyCharged: true }), h(227)).penalty?.label).toBe('Late by 203h · penalty charged');
    expect(dispatchCountdown(clock({ penaltyAt: null, penaltyPaused: true }), h(30)).penalty?.state).toBe('PAUSED');
    expect(dispatchCountdown(clock({ penaltyEnabled: false, penaltyAt: null }), h(30)).penalty).toBeNull();
  });

  it('never shows seconds or negatives', () => {
    expect(formatHoursMinutes(-5_000)).toBe('0m');
    expect(formatHoursMinutes(59_000)).toBe('1m');
    expect(formatHoursMinutes(3_600_000)).toBe('1h');
  });
});
