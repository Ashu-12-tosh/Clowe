import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMERCIAL, handlingFeeFor, mergeCommercial, placementPriceProblems } from './commercial';
import { computeListingEconomics, type SellerEconomicsRates } from './sellerEconomics';

// The owner's Batch 2 fees on a line, with the live statutory rates (TDS 0.1%, TCS 0.5%) and GST 18%.
const f = DEFAULT_COMMERCIAL.fees;
const rates = (handlingWaived = false): SellerEconomicsRates => ({
  commissionPercent: 10,
  gatewayPercent: 2,
  tdsPercent: 0.1,
  tcsPercent: 0.5,
  gst: { meritPercent: 5, standardPercent: 18, valueSlabThresholdPaise: 250_000, uniformPercent: 18 },
  platformFeePaise: 900,
  closingFeePaise: 2_000,
  gtChargePaise: 3_000,
  v2: { ...f, handlingWaived },
});

describe('Batch 2 fees on a line', () => {
  it('a ₹1,000 sale (the worked example)', () => {
    const e = computeListingEconomics({ buyerPricePaise: 100_000, gstRatePercent: 18, rates: rates() });
    const row = (key: string) => e.lines.find((l) => l.key === key)!.amountPaise;
    expect(row('commission')).toBe(-2_000); // referral 2%
    expect(row('gt')).toBe(-1_500); // GT 1.5%
    expect(row('gateway')).toBe(-2_000); // collection 2%
    expect(row('handling')).toBe(-1_900); // ₹1,000–4,999 slab
    expect(row('feeGst')).toBe(-1_332); // 18% of ₹74
    expect(e.gstPaise).toBe(15_254);
    expect(row('tds')).toBe(-85);
    expect(row('tcs')).toBe(-424);
    expect(e.sellerReceivesPaise).toBe(90_759);
    expect(e.sellerKeepsAfterGstPaise).toBe(75_505);
    // The old fixed fees are not charged.
    expect(e.lines.some((l) => l.key === 'platform' || l.key === 'closing')).toBe(false);
  });

  it.each([
    [49_900, 900],
    [50_000, 1_400],
    [99_900, 1_400],
    [100_000, 1_900],
    [499_900, 1_900],
    [500_000, 2_500],
    [1_999_900, 2_500],
    [2_000_000, 4_000],
  ])('handling fee at ₹%d paise is %d paise per unit', (price, fee) => {
    expect(handlingFeeFor(price, f.handlingSlabs)).toBe(fee);
    const e = computeListingEconomics({ buyerPricePaise: price, gstRatePercent: 18, rates: rates() });
    expect(e.handlingFeePaise).toBe(fee);
  });

  it('per unit, on the unit price', () => {
    const e = computeListingEconomics({ buyerPricePaise: 100_000, quantity: 2, gstRatePercent: 18, rates: rates() });
    expect(e.handlingFeePaise).toBe(3_800);
    expect(e.commissionPaise).toBe(4_000);
  });

  it('no handling fee on Premium or for a VIP seller, and less GST', () => {
    const e = computeListingEconomics({ buyerPricePaise: 100_000, gstRatePercent: 18, rates: rates(true) });
    expect(e.handlingFeePaise).toBe(0);
    expect(e.cloweFeeGstPaise).toBe(990); // 18% of ₹55
  });
});

describe('the commercial setting', () => {
  it('merges a partial change and keeps placement prices inside their ranges', () => {
    const next = mergeCommercial(DEFAULT_COMMERCIAL, { fees: { referralPercent: 3 } });
    expect(next.fees.referralPercent).toBe(3);
    expect(next.fees.gtPercent).toBe(1.5);
    expect(placementPriceProblems(DEFAULT_COMMERCIAL)).toEqual([]);
    const out = mergeCommercial(DEFAULT_COMMERCIAL, { ads: { placements: { HOMEPAGE_BANNER: { pricePaise: 10 } } } });
    expect(placementPriceProblems(out)).toEqual(['Homepage Banner: price outside its range']);
  });

  it('refuses nonsense', () => {
    expect(() => mergeCommercial(DEFAULT_COMMERCIAL, { fees: { gstPercent: -1 } })).toThrow();
  });
});
