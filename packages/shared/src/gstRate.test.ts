import { describe, expect, it } from 'vitest';
import { describeTaxDefault, gstRateFor, type GstSettings } from './categoryRules';

/** GST 2.0 defaults: 5% merit, 18% standard, ₹2,500 per piece ex-GST. */
const GST: GstSettings = { meritPercent: 5, standardPercent: 18, valueSlabThresholdPaise: 250_000 };
const SLAB = { taxRule: 'VALUE_SLAB' as const, defaultTaxRatePercent: null };
const flat = (rate: number) => ({ taxRule: null, defaultTaxRatePercent: rate });

describe('gstRateFor — the value slab (apparel per piece, footwear per pair)', () => {
  it('is 5% at ₹2,625 inclusive, exactly ₹2,500 ex-GST', () => {
    const r = gstRateFor(262_500, SLAB, GST);
    expect(r.ratePercent).toBe(5);
    expect(r.exGstUnitPaise).toBe(250_000);
    expect(r.slabBand).toBeNull();
  });

  it('is 18% one paisa above, where ex-GST at 5% passes ₹2,500', () => {
    expect(gstRateFor(262_501, SLAB, GST).ratePercent).toBe(18);
  });

  it('is 18% at ₹2,990, and that is outside the ambiguous band', () => {
    const r = gstRateFor(299_000, SLAB, GST);
    expect(r.ratePercent).toBe(18);
    expect(r.exGstUnitPaise).toBe(253_390);
    expect(r.slabBand).toBeNull();
  });

  it('reports the band where neither slab is self-consistent, ₹2,625.01 to ₹2,950', () => {
    // At 18% a ₹2,800 piece is ₹2,372.88 ex-GST — under ₹2,500 — yet at 5% it
    // is ₹2,666.67, over. Taxed at 18%, never under-collected, and the seller
    // is told a price of ₹2,625 or less would be 5%.
    for (const price of [262_501, 280_000, 295_000]) {
      const r = gstRateFor(price, SLAB, GST);
      expect(r.ratePercent, String(price)).toBe(18);
      expect(r.slabBand, String(price)).toEqual({ fromPaise: 262_501, toPaise: 295_000, meritUpToPaise: 262_500 });
    }
    expect(gstRateFor(295_001, SLAB, GST).slabBand).toBeNull();
  });

  it('judges the price after discount: a ₹2,800 piece discounted to ₹2,600 is 5%', () => {
    expect(gstRateFor(280_000, SLAB, GST).ratePercent).toBe(18);
    expect(gstRateFor(260_000, SLAB, GST).ratePercent).toBe(5);
  });

  it('follows the settings, not compiled-in numbers', () => {
    const r = gstRateFor(262_500, SLAB, { meritPercent: 5, standardPercent: 18, valueSlabThresholdPaise: 100_000 });
    expect(r.ratePercent).toBe(18);
  });
});

describe('gstRateFor — flat categories', () => {
  it('ignores price entirely', () => {
    expect(gstRateFor(100, flat(18), GST).ratePercent).toBe(18);
    expect(gstRateFor(99_999_900, flat(18), GST).ratePercent).toBe(18);
  });

  it('gives jewellery 3% and printed books nil', () => {
    expect(gstRateFor(500_000, flat(3), GST).ratePercent).toBe(3);
    const book = gstRateFor(49_900, flat(0), GST);
    expect(book.ratePercent).toBe(0);
    expect(book.exGstUnitPaise).toBe(49_900);
  });

  it('falls back to the standard rate when a category has none, or none is chosen yet', () => {
    expect(gstRateFor(100_000, { taxRule: null, defaultTaxRatePercent: null }, GST).ratePercent).toBe(18);
    expect(gstRateFor(100_000, null, GST).ratePercent).toBe(18);
  });
});

describe('describeTaxDefault', () => {
  it('states the slab in the settings’ own numbers', () => {
    expect(describeTaxDefault(SLAB, GST)).toBe('5% up to ₹2,500 per piece (ex-GST), 18% above');
    expect(describeTaxDefault(flat(3), GST)).toBe('3%');
  });
});
