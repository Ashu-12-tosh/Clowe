import { describe, expect, it } from 'vitest';
import { computeListingEconomics, gstInclusiveShare, percentOf } from './sellerEconomics';

const RATES = {
  commissionPercent: 10,
  gatewayPercent: 2,
  tdsPercent: 1,
  gstPercent: 18,
  platformFeePaise: 900,
  deliveryFeePaise: 6000,
  closingFeePaise: 2000,
};

describe('computeListingEconomics', () => {
  it('splits a plain price into each component', () => {
    const e = computeListingEconomics({ sellerPricePaise: 100_000, rates: RATES });
    expect(e.buyerPaysPaise).toBe(100_000);
    expect(e.commissionPaise).toBe(10_000);
    expect(e.gatewayFeePaise).toBe(2_000);
    expect(e.platformFeePaise).toBe(900);
    expect(e.deliveryFeePaise).toBe(6_000);
    expect(e.closingFeePaise).toBe(2_000);
    expect(e.tdsPaise).toBe(1_000);
    expect(e.sellerReceivesPaise).toBe(100_000 - 10_000 - 2_000 - 900 - 6_000 - 2_000 - 1_000);
  });

  it('shows the GST inside the price without deducting it', () => {
    // ₹1,000 inclusive of 18% is ₹847.46 + ₹152.54.
    const e = computeListingEconomics({ sellerPricePaise: 100_000, rates: RATES });
    expect(e.gstPaise).toBe(15_254);
    expect(e.lines.find((l) => l.ledgerType === null)).toBeUndefined();
    expect(e.sellerKeepsAfterGstPaise).toBe(e.sellerReceivesPaise - 15_254);
  });

  it('is zero all the way down for a zero price, fixed fees included', () => {
    const e = computeListingEconomics({ sellerPricePaise: 0, rates: RATES });
    expect(e.buyerPaysPaise).toBe(0);
    expect(e.platformFeePaise).toBe(0);
    expect(e.deliveryFeePaise).toBe(0);
    expect(e.closingFeePaise).toBe(0);
    expect(e.sellerReceivesPaise).toBe(0);
    expect(e.lines.every((l) => l.amountPaise === 0)).toBe(true);
  });

  it('rounds every component to a whole paisa, and the lines still add up', () => {
    // ₹333.33 at 10% is 3,333.3 paise: rounded per component, never carried.
    const e = computeListingEconomics({ sellerPricePaise: 33_333, rates: RATES });
    expect(e.commissionPaise).toBe(3_333);
    expect(e.gatewayFeePaise).toBe(667);
    expect(e.tdsPaise).toBe(333);
    // 33,333 / 1.18 = 28,248.3 → 28,248 taxable, 5,085 GST.
    expect(e.gstPaise).toBe(33_333 - 28_248);
    for (const l of e.lines) expect(Number.isInteger(l.amountPaise)).toBe(true);
    const sum = e.lines.reduce((s, l) => s + l.amountPaise, 0);
    expect(sum).toBe(e.sellerReceivesPaise);
    expect(e.sellerReceivesPaise).toBe(33_333 - 3_333 - 667 - 333 - 900 - 6_000 - 2_000);
  });

  it('takes percentages on the line total, fixed fees per line, closing per unit', () => {
    const one = computeListingEconomics({ sellerPricePaise: 33_333, rates: RATES });
    const three = computeListingEconomics({ sellerPricePaise: 33_333, quantity: 3, rates: RATES });
    expect(three.grossPaise).toBe(99_999);
    // Rounding once on 99,999 (10,000) is not three roundings of 33,333 (9,999).
    expect(three.commissionPaise).toBe(10_000);
    expect(three.commissionPaise).not.toBe(one.commissionPaise * 3);
    expect(three.platformFeePaise).toBe(900);
    expect(three.deliveryFeePaise).toBe(6_000);
    expect(three.closingFeePaise).toBe(6_000);
  });

  it('maps every deduction to the ledger type it is posted as', () => {
    const e = computeListingEconomics({ sellerPricePaise: 50_000, rates: RATES });
    expect(e.lines.map((l) => [l.ledgerType, l.amountPaise])).toEqual([
      ['SALE_EARNING', 50_000],
      ['COMMISSION', -5_000],
      ['GATEWAY_FEE', -1_000],
      ['PLATFORM_FEE', -900],
      ['DELIVERY_FEE', -6_000],
      ['CLOSING_FEE', -2_000],
      ['TDS', -500],
    ]);
  });

  it('follows the rates it is given, not a compiled-in number', () => {
    const e = computeListingEconomics({
      sellerPricePaise: 100_000,
      rates: {
        commissionPercent: 15,
        gatewayPercent: 0,
        tdsPercent: 0,
        gstPercent: 5,
        platformFeePaise: 0,
        deliveryFeePaise: 4_500,
        closingFeePaise: 0,
      },
    });
    expect(e.commissionPaise).toBe(15_000);
    expect(e.gatewayFeePaise).toBe(0);
    expect(e.deliveryFeePaise).toBe(4_500);
    expect(e.gstPaise).toBe(100_000 - 95_238);
    expect(e.sellerReceivesPaise).toBe(80_500);
  });
});

describe('percentOf', () => {
  it('rounds half up in paise', () => {
    expect(percentOf(25, 2)).toBe(1); // 0.5 → 1
    expect(percentOf(24, 2)).toBe(0); // 0.48 → 0
  });
});

describe('gstInclusiveShare', () => {
  it('extracts the tax from an inclusive amount, and is zero at 0%', () => {
    expect(gstInclusiveShare(118_00, 18)).toBe(18_00);
    expect(gstInclusiveShare(100_000, 0)).toBe(0);
  });
});
