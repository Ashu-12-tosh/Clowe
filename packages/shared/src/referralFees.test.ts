import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMERCIAL } from './commercial';
import {
  decimalRateToBps,
  fillSlabGaps,
  otherProductsDonorFor,
  parseSlabLabel,
  referralPercentFor,
  slabFor,
  slabGaps,
  slabLabelOf,
  type ReferralFeeCategory,
  type ReferralFeeSlab,
} from './referralFees';
import { computeListingEconomics, type SellerEconomicsRates } from './sellerEconomics';

/** Rows as the schedule writes them: [slab, CLOWE rate]. */
function category(group: string, sheetCategory: string, rows: [string, string][]): ReferralFeeCategory {
  return {
    group,
    sheetCategory,
    slabs: rows.map(([label, rate]) => ({ ...parseSlabLabel(label)!, rateBps: decimalRateToBps(rate), label })),
  };
}

// Rows exactly as in "Clowe_Referral_Fee_Schedule (6).xlsx" (sheet "Clowe Fee Schedule", CLOWE Rate).
const PET_COMFORTERS = 'Pet comforters including Bed, Feeder, Cages, Carriers, Crates, Kennels and Doors';
const SHEET = [
  category('Media', 'School Textbook Bundles', [['<= 250', '0'], ['> 250 and <= 1,000', '0.005'], ['> 1,000 and <= 1,500', '0.015'], ['> 1,500', '0.02']]),
  category('Media', 'Books', [['<= 250', '0'], ['> 250 and <= 500', '0.01'], ['> 500 and <= 1,000', '0.02'], ['> 1,000', '0.12']]),
  category('Softline', 'Apparel - Shirts', [['> 1,000', '0.19']]),
  category('Softline', 'Apparel - Other products', [['<= 1,000', '0'], ['> 1,000', '0.17']]),
  category('Softline', 'Shoes', [['<= 1,000', '0'], ['> 1,000', '0.07']]),
  category('CE/PC/Wireless', 'Mobile Phones', [['All prices', '0.04']]),
  category('CE/PC/Wireless', 'PC Components - RAM and Motherboards', [['<= 300', '0']]),
  category('CE/PC/Wireless', 'Office - Other products', [['<= 1,000', '0'], ['> 1,000', '0.09']]),
  category('Consumables', 'Beauty - Fragrance', [['<= 500', '0'], ['> 500 and <= 1,000', '0.12'], ['> 1,000', '0.085']]),
  category('Consumables', 'Pet - Other products', [['<= 1,000', '0'], ['> 1,000', '0.1']]),
  category('Consumables', PET_COMFORTERS, [['<= 1,000', '0']]),
  category('Other Hardline', 'Gas Stoves and Pressure Cookers', [['<= 1,000', '0'], ['> 1,000 and <= 1,500', '0.05']]),
  category('Other Hardline', 'Kitchen - Other products', [['<= 1,000', '0'], ['> 1,000', '0.1']]),
  category('Other Hardline', 'Sports - Other products', [['<= 1,000', '0'], ['> 1,000', '0.105']]),
];
const BY_NAME = new Map(SHEET.map((c) => [c.sheetCategory, c]));
const filled = (name: string) => fillSlabGaps(BY_NAME.get(name)!, BY_NAME).slabs;
const rateAt = (name: string, rupees: number) => slabFor(filled(name), Math.round(rupees * 100))?.rateBps;

describe('slab labels', () => {
  it.each([
    ['<= 250', 0, 25_000],
    ['> 1,000', 100_000, null],
    ['> 250 and <= 500', 25_000, 50_000],
    ['> 19,000 and <= 49,000', 1_900_000, 4_900_000],
    ['All prices', 0, null],
  ])('%s', (label, above, upTo) => {
    expect(parseSlabLabel(label)).toEqual({ abovePaise: above, upToPaise: upTo });
    expect(slabLabelOf(above, upTo)).toBe(label);
  });

  it('refuses what it does not understand', () => {
    expect(parseSlabLabel('250 to 500')).toBeNull();
    expect(parseSlabLabel('> 500 and <= 250')).toBeNull();
  });

  it('reads the sheet’s decimal rates exactly, in basis points', () => {
    expect(decimalRateToBps('0.19')).toBe(1_900);
    expect(decimalRateToBps('0.005')).toBe(50);
    expect(decimalRateToBps('0.275')).toBe(2_750);
    expect(decimalRateToBps('0')).toBe(0);
    expect(() => decimalRateToBps('19')).toThrow();
  });
});

describe('the slab a price falls in (the upper bound belongs to its slab)', () => {
  it.each([
    [0, 0],
    [250, 0],
    [250.01, 50],
    [1_000, 50],
    [1_000.01, 150],
    [1_500, 150],
    [1_500.01, 200],
  ])('School Textbook Bundles at ₹%d → %d bps', (rupees, bps) => {
    expect(rateAt('School Textbook Bundles', rupees)).toBe(bps);
  });

  it.each([
    [500, 0],
    [500.01, 1_200],
    [1_000, 1_200],
    [1_000.01, 850],
  ])('Beauty - Fragrance at ₹%d → %d bps', (rupees, bps) => {
    expect(rateAt('Beauty - Fragrance', rupees)).toBe(bps);
  });

  it.each([
    [250, 0],
    [300, 100],
    [500, 100],
    [500.01, 200],
    [1_000, 200],
    [1_000.01, 1_200],
  ])('Books at ₹%d → %d bps', (rupees, bps) => {
    expect(rateAt('Books', rupees)).toBe(bps);
  });

  it('one rate per group', () => {
    expect(rateAt('Books', 750)).toBe(200); // Media
    expect(rateAt('Shoes', 1_200)).toBe(700); // Softline
    expect(rateAt('Mobile Phones', 25_000)).toBe(400); // CE/PC/Wireless, all prices
    expect(rateAt('Mobile Phones', 0)).toBe(400);
    expect(rateAt('Beauty - Fragrance', 600)).toBe(1_200); // Consumables
    expect(rateAt('Sports - Other products', 1_200)).toBe(1_050); // Other Hardline
  });
});

describe('gaps borrow the family’s "… - Other products" row', () => {
  it('Apparel - Shirts up to ₹1,000 is Apparel - Other products (0%); above, its own 19%', () => {
    expect(slabGaps(BY_NAME.get('Apparel - Shirts')!.slabs)).toEqual([[0, 100_000]]);
    const slabs = filled('Apparel - Shirts');
    expect(slabFor(slabs, 100_000)).toMatchObject({ rateBps: 0, borrowedFrom: 'Apparel - Other products', label: '<= 1,000' });
    expect(slabFor(slabs, 100_001)).toMatchObject({ rateBps: 1_900, label: '> 1,000' });
    expect(slabFor(slabs, 100_001)?.borrowedFrom).toBeUndefined();
  });

  it('Pet comforters (no " - " in its name) above ₹1,000 is Pet - Other products (10%)', () => {
    expect(otherProductsDonorFor(BY_NAME.get(PET_COMFORTERS)!, SHEET)?.sheetCategory).toBe('Pet - Other products');
    expect(rateAt(PET_COMFORTERS, 1_000)).toBe(0);
    expect(rateAt(PET_COMFORTERS, 1_000.01)).toBe(1_000);
  });

  it('a gap whose group has no fitting "Other products" row is left for the import to list', () => {
    const ram = fillSlabGaps(BY_NAME.get('PC Components - RAM and Motherboards')!, BY_NAME);
    expect(ram).toMatchObject({ unfilled: [[30_000, null]], donor: null });
    // Office - Other products is in the group, but "Office" does not begin "PC Components".
    const stoves = fillSlabGaps(BY_NAME.get('Gas Stoves and Pressure Cookers')!, BY_NAME);
    expect(stoves).toMatchObject({ unfilled: [[150_000, null]], donor: null });
  });

  it('…or filled from the row the owner picks', () => {
    const stoves = fillSlabGaps(BY_NAME.get('Gas Stoves and Pressure Cookers')!, BY_NAME, 'Kitchen - Other products');
    expect(stoves.unfilled).toEqual([]);
    expect(slabFor(stoves.slabs, 150_000)).toMatchObject({ rateBps: 500, label: '> 1,000 and <= 1,500' });
    expect(slabFor(stoves.slabs, 150_001)).toMatchObject({ rateBps: 1_000, label: '> 1,500', borrowedFrom: 'Kitchen - Other products' });
  });

  it('a price no slab holds falls back to the flat rate', () => {
    expect(referralPercentFor(BY_NAME.get('PC Components - RAM and Motherboards')!.slabs, 50_000, 2)).toEqual({ percent: 2, slab: null });
    expect(referralPercentFor(null, 50_000, 2)).toEqual({ percent: 2, slab: null });
  });
});

describe('on a sale: the full price at its slab’s rate, the other fees on top', () => {
  const f = DEFAULT_COMMERCIAL.fees;
  const rates = (slabs: ReferralFeeSlab[]): SellerEconomicsRates => ({
    commissionPercent: 10,
    gatewayPercent: 2,
    tdsPercent: 0.1,
    tcsPercent: 0.5,
    gst: { meritPercent: 5, standardPercent: 18, valueSlabThresholdPaise: 250_000, uniformPercent: 18 },
    platformFeePaise: 900,
    closingFeePaise: 2_000,
    gtChargePaise: 3_000,
    v2: { ...f, referralSlabs: slabs, handlingWaived: false },
  });
  const row = (e: ReturnType<typeof computeListingEconomics>, key: string) => e.lines.find((l) => l.key === key)!.amountPaise;

  it('the sheet’s example: an Apparel - Shirts item at ₹1,500 pays 19% = ₹285', () => {
    const e = computeListingEconomics({ buyerPricePaise: 150_000, gstRatePercent: 5, rates: rates(filled('Apparel - Shirts')) });
    expect(row(e, 'commission')).toBe(-28_500);
    expect(e.lines.find((l) => l.key === 'commission')!.label).toBe('Referral fee (19% of the selling price)');
    // GT 1.5%, collection 2%, handling ₹19 (₹1,000–4,999), 18% GST on all four.
    expect(row(e, 'gt')).toBe(-2_250);
    expect(row(e, 'gateway')).toBe(-3_000);
    expect(row(e, 'handling')).toBe(-1_900);
    expect(row(e, 'feeGst')).toBe(-6_417); // 18% of ₹356.50
    expect(e.gstPaise).toBe(7_143); // 5% inside ₹1,500
    expect(row(e, 'tds')).toBe(-143); // 0.1% of ₹1,428.57
    expect(row(e, 'tcs')).toBe(-714); // 0.5% of ₹1,428.57
    expect(e.sellerReceivesPaise).toBe(107_076);
    expect(e.sellerKeepsAfterGstPaise).toBe(99_933);
  });

  it('a ₹1,000 shirt: the borrowed 0% — GT, collection, handling and their GST only', () => {
    const e = computeListingEconomics({ buyerPricePaise: 100_000, gstRatePercent: 5, rates: rates(filled('Apparel - Shirts')) });
    expect(row(e, 'commission')).toBe(-0);
    expect(row(e, 'gt')).toBe(-1_500);
    expect(row(e, 'gateway')).toBe(-2_000);
    expect(row(e, 'handling')).toBe(-1_900);
    expect(row(e, 'feeGst')).toBe(-972); // 18% of ₹54
    expect(e.gstPaise).toBe(4_762);
    expect(row(e, 'tds')).toBe(-95);
    expect(row(e, 'tcs')).toBe(-476);
    expect(e.sellerReceivesPaise).toBe(93_057);
    expect(e.sellerKeepsAfterGstPaise).toBe(88_295);
  });

  it('the rate follows the unit price, not the line total', () => {
    const e = computeListingEconomics({ buyerPricePaise: 90_000, quantity: 3, gstRatePercent: 5, rates: rates(filled('Apparel - Shirts')) });
    expect(e.commissionPaise).toBe(0); // ₹900 each: the ≤ ₹1,000 slab, though the line is ₹2,700
  });
});
