import { describe, expect, it } from 'vitest';
import { lineShares, valueOfLines } from './codAmount';

const line = (id: string, pricePaise: number, quantity = 1, promoDiscountPaise = 0) => ({
  id,
  pricePaise,
  quantity,
  promoDiscountPaise,
});

describe('what each line is worth to the buyer', () => {
  it('a single-line order is worth the whole total, delivery fee and discounts included', () => {
    expect(valueOfLines(53_900, [line('a', 49_900)], ['a'])).toBe(53_900);
  });

  it('shares add up to the total exactly, however it divides', () => {
    const lines = [line('a', 33_333), line('b', 33_333), line('c', 33_334)];
    for (const total of [100_000, 99_999, 100_001, 1, 0]) {
      const shares = lineShares(total, lines);
      expect([...shares.values()].reduce((a, b) => a + b, 0), String(total)).toBe(total);
    }
  });

  it('spreads a coupon and a delivery fee in proportion to each line’s price less its promotion', () => {
    // 60,000 + 40,000 (less a 10,000 promotion) = 90,000 of goods; paid 81,000.
    const lines = [line('a', 30_000, 2), line('b', 40_000, 1, 10_000)];
    const shares = lineShares(81_000, lines);
    expect(shares.get('a')).toBe(54_000);
    expect(shares.get('b')).toBe(27_000);
  });

  it('gives the same share whichever lines are asked about, so separate parcels never double-collect', () => {
    const lines = [line('a', 12_345), line('b', 67_890, 2), line('c', 999)];
    const total = 150_000;
    const each = ['a', 'b', 'c'].map((id) => valueOfLines(total, lines, [id]));
    expect(each.reduce((x, y) => x + y, 0)).toBe(total);
    expect(valueOfLines(total, lines, ['a', 'c'])).toBe(each[0]! + each[2]!);
  });

  it('splits evenly when nothing is priced, and never goes negative', () => {
    expect([...lineShares(5, [line('a', 0), line('b', 0)]).values()]).toEqual([3, 2]);
    expect([...lineShares(-10, [line('a', 100)]).values()]).toEqual([0]);
  });
});
