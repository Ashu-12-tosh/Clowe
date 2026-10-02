import { describe, expect, it } from 'vitest';
import { breakdownRows, computeListingEconomics, gstInclusiveShare, percentOf } from './sellerEconomics';

const RATES = {
  commissionPercent: 10,
  gatewayPercent: 2,
  // The rates in force: TDS 0.1% (s.194-O since 1.10.2024), TCS 0.5% (s.52
  // CGST since 10.07.2024), both on the value ex-GST.
  tdsPercent: 0.1,
  tcsPercent: 0.5,
  gst: { meritPercent: 5, standardPercent: 18, valueSlabThresholdPaise: 250_000 },
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
    // ₹1,000 at 18% is ₹847.46 ex-GST: TDS 0.1% = ₹0.85, TCS 0.5% = ₹4.24.
    expect(e.tdsPaise).toBe(85);
    expect(e.tcsPaise).toBe(424);
    expect(e.sellerReceivesPaise).toBe(100_000 - 10_000 - 2_000 - 900 - 6_000 - 2_000 - 85 - 424);
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
    // 33,333 / 1.18 = 28,248.3 → 28,248 taxable, 5,085 GST; TDS and TCS on 28,248.
    expect(e.gstPaise).toBe(33_333 - 28_248);
    expect(e.tdsPaise).toBe(28);
    expect(e.tcsPaise).toBe(141);
    for (const l of e.lines) expect(Number.isInteger(l.amountPaise)).toBe(true);
    const sum = e.lines.reduce((s, l) => s + l.amountPaise, 0);
    expect(sum).toBe(e.sellerReceivesPaise);
    expect(e.sellerReceivesPaise).toBe(33_333 - 3_333 - 667 - 28 - 141 - 900 - 6_000 - 2_000);
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
      // ₹500 at 18% is ₹423.73 ex-GST.
      ['TDS', -42],
      ['GST_TCS', -212],
    ]);
  });

  it('follows the rates it is given, not a compiled-in number', () => {
    const e = computeListingEconomics({
      sellerPricePaise: 100_000,
      rates: {
        commissionPercent: 15,
        gatewayPercent: 0,
        tdsPercent: 0,
        tcsPercent: 0,
        gst: { meritPercent: 5, standardPercent: 18, valueSlabThresholdPaise: 250_000 },
        platformFeePaise: 0,
        deliveryFeePaise: 4_500,
        closingFeePaise: 0,
      },
      // A flat 5% category: the rate comes from the category, not the rates.
      taxRules: { taxRule: null, defaultTaxRatePercent: 5 },
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

describe('computeListingEconomics — GST comes from the category, via gstRateFor', () => {
  const SLAB = { taxRule: 'VALUE_SLAB' as const, defaultTaxRatePercent: null };

  it('takes 5% out of a ₹2,625 shirt and 18% out of a ₹2,990 one', () => {
    const cheap = computeListingEconomics({ sellerPricePaise: 262_500, rates: RATES, taxRules: SLAB });
    expect(cheap.gstRatePercent).toBe(5);
    expect(cheap.gstPaise).toBe(12_500);
    const dear = computeListingEconomics({ sellerPricePaise: 299_000, rates: RATES, taxRules: SLAB });
    expect(dear.gstRatePercent).toBe(18);
    expect(dear.gstPaise).toBe(45_610);
  });

  it('flags the ambiguous band for the seller', () => {
    expect(computeListingEconomics({ sellerPricePaise: 280_000, rates: RATES, taxRules: SLAB }).gstSlabBand).not.toBeNull();
    expect(computeListingEconomics({ sellerPricePaise: 299_000, rates: RATES, taxRules: SLAB }).gstSlabBand).toBeNull();
  });

  it('uses the standard rate before a category is chosen', () => {
    expect(computeListingEconomics({ sellerPricePaise: 100_000, rates: RATES }).gstRatePercent).toBe(18);
  });
});

describe('computeListingEconomics — TDS and TCS on the value ex-GST', () => {
  it('takes them off what the seller sold, not what the buyer paid in tax', () => {
    // A ₹2,625 shirt is ₹2,500 ex-GST at 5%: TDS 0.1% = ₹2.50, TCS 0.5% = ₹12.50.
    const e = computeListingEconomics({
      sellerPricePaise: 262_500,
      rates: RATES,
      taxRules: { taxRule: 'VALUE_SLAB', defaultTaxRatePercent: null },
    });
    expect(e.exGstPaise).toBe(250_000);
    expect(e.tdsPaise).toBe(250);
    expect(e.tcsPaise).toBe(1_250);
  });

  it('posts TCS as its own ledger line', () => {
    const e = computeListingEconomics({ sellerPricePaise: 100_000, rates: RATES });
    expect(e.lines.find((l) => l.key === 'tcs')).toMatchObject({ ledgerType: 'GST_TCS', amountPaise: -424 });
  });
});

describe('breakdownRows', () => {
  const rows = (price: number, taxRules?: { taxRule: 'VALUE_SLAB'; defaultTaxRatePercent: null }) =>
    breakdownRows(computeListingEconomics({ sellerPricePaise: price, rates: RATES, taxRules }));

  it('reads top to bottom in the order the seller follows the money', () => {
    expect(rows(100_000).map((r) => [r.kind, r.label])).toEqual([
      ['start', 'Buyer pays'],
      ['deduction', 'Commission (10%)'],
      ['deduction', 'Payment gateway (2%)'],
      ['deduction', 'Platform fee'],
      ['deduction', 'Delivery fee'],
      ['deduction', 'Closing fee'],
      ['deduction', 'TDS (0.1%)'],
      ['deduction', 'TCS (0.5%)'],
      ['subtotal', 'Paid to your bank'],
      ['tax', 'GST you remit (18%)'],
      ['total', 'Your earning'],
    ]);
  });

  it('signs every row, and each total is the sum of the rows above it', () => {
    for (const price of [100_000, 33_333, 262_500, 299_000]) {
      const r = rows(price, { taxRule: 'VALUE_SLAB', defaultTaxRatePercent: null });
      let running = 0;
      for (const row of r) {
        if (row.kind === 'subtotal' || row.kind === 'total') expect(row.amountPaise, `${price} ${row.key}`).toBe(running);
        else running += row.amountPaise;
        if (row.kind === 'deduction' || row.kind === 'tax') expect(row.amountPaise, row.key).toBeLessThanOrEqual(0);
      }
    }
  });

  it('shows the rate the category gave, in the GST row', () => {
    const gst = rows(262_500, { taxRule: 'VALUE_SLAB', defaultTaxRatePercent: null }).find((r) => r.key === 'gst');
    expect(gst).toEqual({ key: 'gst', label: 'GST you remit (5%)', amountPaise: -12_500, kind: 'tax' });
  });
});
