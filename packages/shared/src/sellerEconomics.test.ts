import { describe, expect, it } from 'vitest';
import { computeListingEconomics, percentOf } from './sellerEconomics';

const RATES = { commissionPercent: 10, gatewayPercent: 2, tdsPercent: 1 };

describe('computeListingEconomics', () => {
  it('splits a plain price into each component', () => {
    const e = computeListingEconomics({ sellerPricePaise: 100_000, rates: RATES });
    expect(e.buyerPaysPaise).toBe(100_000);
    expect(e.commissionPaise).toBe(10_000);
    expect(e.gatewayFeePaise).toBe(2_000);
    expect(e.tdsPaise).toBe(1_000);
    expect(e.sellerReceivesPaise).toBe(87_000);
  });

  it('is zero all the way down for a zero price', () => {
    const e = computeListingEconomics({ sellerPricePaise: 0, rates: RATES });
    expect(e.buyerPaysPaise).toBe(0);
    expect(e.sellerReceivesPaise).toBe(0);
    expect(e.lines.every((l) => l.amountPaise === 0)).toBe(true);
  });

  it('rounds every component to a whole paisa, and the lines still add up', () => {
    // ₹333.33 at 10% is 3,333.3 paise: rounded per component, never carried.
    const e = computeListingEconomics({ sellerPricePaise: 33_333, rates: RATES });
    expect(e.commissionPaise).toBe(3_333);
    expect(e.gatewayFeePaise).toBe(667);
    expect(e.tdsPaise).toBe(333);
    expect(Number.isInteger(e.sellerReceivesPaise)).toBe(true);
    const sum = e.lines.reduce((s, l) => s + l.amountPaise, 0);
    expect(sum).toBe(e.sellerReceivesPaise);
    expect(e.sellerReceivesPaise).toBe(33_333 - 3_333 - 667 - 333);
  });

  it('takes rates on the line total, not per unit', () => {
    const one = computeListingEconomics({ sellerPricePaise: 33_333, rates: RATES });
    const three = computeListingEconomics({ sellerPricePaise: 33_333, quantity: 3, rates: RATES });
    expect(three.grossPaise).toBe(99_999);
    // Rounding once on 99,999 (10,000) is not three roundings of 33,333 (9,999).
    expect(three.commissionPaise).toBe(10_000);
    expect(three.commissionPaise).not.toBe(one.commissionPaise * 3);
  });

  it('maps every deduction to the ledger type it is posted as', () => {
    const e = computeListingEconomics({ sellerPricePaise: 50_000, rates: RATES });
    expect(e.lines.map((l) => [l.ledgerType, l.amountPaise])).toEqual([
      ['SALE_EARNING', 50_000],
      ['COMMISSION', -5_000],
      ['GATEWAY_FEE', -1_000],
      ['TDS', -500],
    ]);
  });

  it('follows the rates it is given, not a compiled-in number', () => {
    const e = computeListingEconomics({
      sellerPricePaise: 100_000,
      rates: { commissionPercent: 15, gatewayPercent: 0, tdsPercent: 0 },
    });
    expect(e.commissionPaise).toBe(15_000);
    expect(e.gatewayFeePaise).toBe(0);
    expect(e.sellerReceivesPaise).toBe(85_000);
  });
});

describe('percentOf', () => {
  it('rounds half up in paise', () => {
    expect(percentOf(25, 2)).toBe(1); // 0.5 → 1
    expect(percentOf(24, 2)).toBe(0); // 0.48 → 0
  });
});
