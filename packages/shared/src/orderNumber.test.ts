import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ORDER_CODE_ALPHABET, ORDER_CODE_LENGTH, ORDER_NUMBER_PATTERN, newOrderNumber } from './orderNumber';
import { trackOrderSchema } from './growth';

describe('order numbers', () => {
  it('makes new numbers of 10 characters with no look-alikes, all different', () => {
    const made = Array.from({ length: 2000 }, () => newOrderNumber(randomInt));
    for (const n of made) {
      expect(n).toMatch(/^CLW-[A-Z0-9]{10}$/);
      expect(n.slice(4)).not.toMatch(/[01OIL]/);
      expect(n).toMatch(ORDER_NUMBER_PATTERN);
    }
    expect(new Set(made).size).toBe(made.length);
  });

  it('turns each random pick into a character of the alphabet', () => {
    expect(ORDER_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(ORDER_CODE_LENGTH).toBeGreaterThanOrEqual(8);
    let k = 0;
    const steps = Array.from({ length: ORDER_CODE_LENGTH }, () => k++ % ORDER_CODE_ALPHABET.length);
    expect(newOrderNumber(() => steps.shift()!)).toBe(`CLW-${ORDER_CODE_ALPHABET.slice(0, ORDER_CODE_LENGTH)}`);
    expect(newOrderNumber((n) => n - 1)).toBe(`CLW-${'9'.repeat(ORDER_CODE_LENGTH)}`);
  });

  it('accepts both formats in tracking, in any letter case', () => {
    const phone = '9876543210';
    for (const orderNumber of ['CLW-2026-424242', 'clw-2025-000001', 'CLW-7KQ3MX9P2T', ' clw-7kq3mx9p2t ']) {
      expect(trackOrderSchema.safeParse({ orderNumber, phone }).success).toBe(true);
    }
    for (const orderNumber of ['CLW-7KQ3MX9P2', 'CLW-7KQ3MX9P2TT', 'CLW-0KQ3MX9P2T', 'CLW-IKQ3MX9P2T', 'CLW-26-424242', '7KQ3MX9P2T']) {
      expect(trackOrderSchema.safeParse({ orderNumber, phone }).success).toBe(false);
    }
  });
});
