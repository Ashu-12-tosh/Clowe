import { describe, expect, it } from 'vitest';
import { WINDOW_MAX_MS, testWindowClosesAt } from './webhookTestWindow';

const opened = Date.parse('2026-10-29T18:00:00.000Z');
const at = (min: number) => opened + min * 60_000;
const iso = (min: number) => new Date(at(min)).toISOString();

describe('the Payouts webhook dashboard-test window', () => {
  it('is closed unless set to a valid time', () => {
    expect(testWindowClosesAt(at(1), undefined, opened)).toBeNull();
    expect(testWindowClosesAt(at(1), '', opened)).toBeNull();
    expect(testWindowClosesAt(at(1), 'tomorrow', opened)).toBeNull();
  });

  it('runs from when the API started to the set time', () => {
    expect(testWindowClosesAt(at(0), iso(20), opened)?.toISOString()).toBe(iso(20));
    expect(testWindowClosesAt(at(19), iso(20), opened)).not.toBeNull();
    expect(testWindowClosesAt(at(20), iso(20), opened)).toBeNull();
    expect(testWindowClosesAt(at(-1), iso(20), opened)).toBeNull();
  });

  it('never runs more than 30 minutes, whatever time it is set to', () => {
    expect(WINDOW_MAX_MS).toBe(30 * 60_000);
    expect(testWindowClosesAt(at(29), iso(600), opened)?.toISOString()).toBe(iso(30));
    expect(testWindowClosesAt(at(30), iso(600), opened)).toBeNull();
    expect(testWindowClosesAt(at(45), iso(600), opened)).toBeNull();
  });

  it('a time already past opens nothing', () => {
    expect(testWindowClosesAt(at(1), iso(-5), opened)).toBeNull();
  });
});
