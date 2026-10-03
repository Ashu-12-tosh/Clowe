import { describe, expect, it } from 'vitest';
import {
  buyerPriceFor,
  describeTaxDefault,
  gstRateForExGst,
  gstRateForInclusive,
  sellerPriceFromBuyer,
  type GstSettings,
} from './categoryRules';

/** GST 2.0 defaults: 5% merit, 18% standard, ₹2,500 per piece ex-GST. */
const GST: GstSettings = { meritPercent: 5, standardPercent: 18, valueSlabThresholdPaise: 250_000 };
const SLAB = { taxRule: 'VALUE_SLAB' as const, defaultTaxRatePercent: null };
const flat = (rate: number) => ({ taxRule: null, defaultTaxRatePercent: rate });

describe('the seller price, before GST — the value slab', () => {
  it('is 5% up to ₹2,500 and 18% from a paisa more, judged on the seller price itself', () => {
    expect(gstRateForExGst(250_000, SLAB, GST).ratePercent).toBe(5);
    expect(gstRateForExGst(250_001, SLAB, GST).ratePercent).toBe(18);
  });

  it('has no ambiguous band: every seller price gets one rate', () => {
    for (let ex = 230_000; ex <= 260_000; ex += 137) {
      const { ratePercent } = gstRateForExGst(ex, SLAB, GST);
      expect(ratePercent, String(ex)).toBe(ex <= 250_000 ? 5 : 18);
    }
  });

  it('follows the settings, not compiled-in numbers', () => {
    expect(gstRateForExGst(150_000, SLAB, { ...GST, valueSlabThresholdPaise: 100_000 }).ratePercent).toBe(18);
  });
});

describe('buyerPriceFor', () => {
  it('adds GST on top: ₹100 at 18% is ₹118', () => {
    expect(buyerPriceFor(10_000, flat(18), GST)).toEqual({ exGstPaise: 10_000, gstPaise: 1_800, buyerPaise: 11_800, ratePercent: 18 });
  });

  it('prices apparel on its slab and books at nil', () => {
    expect(buyerPriceFor(250_000, SLAB, GST).buyerPaise).toBe(262_500);
    expect(buyerPriceFor(300_000, SLAB, GST).buyerPaise).toBe(354_000);
    expect(buyerPriceFor(49_900, flat(0), GST).buyerPaise).toBe(49_900);
  });

  it('uses the standard rate before a category is chosen', () => {
    expect(buyerPriceFor(10_000, null, GST).ratePercent).toBe(18);
  });
});

describe('an order line — GST inside a GST-inclusive price', () => {
  it('is 5% at ₹2,625 inclusive (₹2,500 ex-GST) and 18% a paisa above', () => {
    expect(gstRateForInclusive(262_500, SLAB, GST)).toEqual({ ratePercent: 5, exGstUnitPaise: 250_000 });
    expect(gstRateForInclusive(262_501, SLAB, GST).ratePercent).toBe(18);
  });

  it('judges the price after discount: a ₹2,800 piece discounted to ₹2,600 is 5%', () => {
    expect(gstRateForInclusive(280_000, SLAB, GST).ratePercent).toBe(18);
    expect(gstRateForInclusive(260_000, SLAB, GST).ratePercent).toBe(5);
  });

  it('gives flat categories their rate whatever the price', () => {
    expect(gstRateForInclusive(100, flat(18), GST).ratePercent).toBe(18);
    expect(gstRateForInclusive(500_000, flat(3), GST).ratePercent).toBe(3);
    expect(gstRateForInclusive(49_900, flat(0), GST)).toEqual({ ratePercent: 0, exGstUnitPaise: 49_900 });
    expect(gstRateForInclusive(100_000, null, GST).ratePercent).toBe(18);
  });
});

describe('sellerPriceFromBuyer', () => {
  it('gives back exactly the seller price a buyer price was built from', () => {
    for (const rules of [SLAB, flat(18), flat(5), flat(3), flat(0), null]) {
      for (let ex = 100; ex < 600_000; ex += 997) {
        const { buyerPaise, ratePercent } = buyerPriceFor(ex, rules, GST);
        const back = sellerPriceFromBuyer(buyerPaise, rules, GST);
        expect([back.exGstPaise, back.ratePercent, back.ambiguous], `${JSON.stringify(rules)} ${ex}`).toEqual([ex, ratePercent, false]);
      }
    }
  });

  it('flags an old inclusive price in the value-slab band, where no seller price keeps it', () => {
    // ₹2,800 at 18% is ₹2,372.88 before GST — which on its own is a 5% price.
    expect(sellerPriceFromBuyer(280_000, SLAB, GST)).toEqual({ exGstPaise: 237_288, ratePercent: 18, ambiguous: true });
    expect(sellerPriceFromBuyer(299_000, SLAB, GST).ambiguous).toBe(false);
    expect(sellerPriceFromBuyer(262_500, SLAB, GST).ambiguous).toBe(false);
  });
});

describe('describeTaxDefault', () => {
  it('states the slab in the settings’ own numbers', () => {
    expect(describeTaxDefault(SLAB, GST)).toBe('5% up to ₹2,500 per piece (ex-GST), 18% above');
    expect(describeTaxDefault(flat(3), GST)).toBe('3%');
  });
});
