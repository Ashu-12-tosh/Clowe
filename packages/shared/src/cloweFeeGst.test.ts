import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMERCIAL } from './commercial';
import { computeListingEconomics, type SellerEconomicsRates } from './sellerEconomics';
import { gstStateCodeOf, isIntraStateSupply, recipientStateCode, splitGst } from './gstPlace';
import { financialYearOf, sellerInvoiceNumber } from './sellerInvoice';
import type { ReferralFeeSlab } from './referralFees';

// The owner's rule (26 Oct): every Clowe charge carries 18% GST, SAC 998599;
// TDS and TCS are on the price before GST; the parts add up to the payout.

const fees = DEFAULT_COMMERCIAL.fees;
function rates(over: Partial<NonNullable<SellerEconomicsRates['v2']>> = {}): SellerEconomicsRates {
  return {
    commissionPercent: 0,
    gatewayPercent: 0,
    tdsPercent: 0.1,
    tcsPercent: 0.5,
    gst: { meritPercent: 5, standardPercent: 18, valueSlabThresholdPaise: 250_000, uniformPercent: 18 },
    platformFeePaise: 0,
    closingFeePaise: 0,
    gtChargePaise: 0,
    v2: {
      referralPercent: 2,
      gtPercent: fees.gtPercent,
      collectionPercent: fees.collectionPercent,
      handlingSlabs: fees.handlingSlabs,
      handlingWaived: false,
      gstPercent: fees.gstPercent,
      ...over,
    },
  };
}
// + 0: a zero deduction is stored as -0.
const line = (e: ReturnType<typeof computeListingEconomics>, key: string) => (e.lines.find((l) => l.key === key)?.amountPaise ?? 0) + 0;
/** Gross less every posted deduction: must be exactly what the seller is paid. */
const addsUp = (e: ReturnType<typeof computeListingEconomics>) =>
  e.lines.filter((l) => l.key !== 'sale' && l.ledgerType !== null).reduce((sum, l) => sum + l.amountPaise, e.grossPaise) === e.sellerReceivesPaise;

describe('GST @18% on Clowe fees — the ₹1,000 example', () => {
  const e = computeListingEconomics({ buyerPricePaise: 100_000, gstRatePercent: 18, rates: rates() });

  it('charges each fee, 18% GST on their total, and TDS/TCS on the price before GST', () => {
    expect(e.grossPaise).toBe(100_000);
    expect(e.gstPaise).toBe(15_254); // the GST inside ₹1,000 at 18%, the seller's to file
    expect(e.exGstPaise).toBe(84_746);
    expect(line(e, 'commission')).toBe(-2_000); // referral 2%
    expect(line(e, 'gt')).toBe(-1_500); // GT 1.5%
    expect(line(e, 'gateway')).toBe(-2_000); // collection 2%
    expect(line(e, 'handling')).toBe(-1_900); // ₹1,000 slab
    expect(line(e, 'feeGst')).toBe(-1_332); // 18% of ₹74.00
    expect(line(e, 'tds')).toBe(-85); // 0.1% of ₹847.46
    expect(line(e, 'tcs')).toBe(-424); // 0.5% of ₹847.46
    expect(e.sellerReceivesPaise).toBe(90_759);
    expect(100_000 - e.sellerReceivesPaise).toBe(2_000 + 1_500 + 2_000 + 1_900 + 1_332 + 85 + 424);
  });

  it('names the GST its own line', () => {
    expect(e.lines.find((l) => l.key === 'feeGst')).toMatchObject({ label: 'GST @18% on Clowe fees', ledgerType: 'CLOWE_FEE_GST' });
  });
});

describe('GST @18% on Clowe fees — slabs and categories', () => {
  it('follows the handling-fee slab at each boundary', () => {
    const handling = (unit: number) => -line(computeListingEconomics({ buyerPricePaise: unit, gstRatePercent: 18, rates: rates() }), 'handling');
    expect(handling(49_999)).toBe(900);
    expect(handling(50_000)).toBe(1_400);
    expect(handling(99_999)).toBe(1_400);
    expect(handling(100_000)).toBe(1_900);
    expect(handling(499_999)).toBe(1_900);
    expect(handling(500_000)).toBe(2_500);
    expect(handling(2_000_000)).toBe(4_000);
  });

  it('takes the referral rate from the slab of the unit price (upper bound inclusive)', () => {
    const slabs: ReferralFeeSlab[] = [
      { abovePaise: 0, upToPaise: 50_000, rateBps: 0, label: '<= 500' },
      { abovePaise: 50_000, upToPaise: 100_000, rateBps: 500, label: '> 500 and <= 1,000' },
      { abovePaise: 100_000, upToPaise: null, rateBps: 1_000, label: '> 1,000' },
    ];
    const at = (unit: number) => computeListingEconomics({ buyerPricePaise: unit, gstRatePercent: 18, rates: rates({ referralSlabs: slabs }) });
    expect(line(at(50_000), 'commission')).toBe(0);
    expect(line(at(50_001), 'commission')).toBe(-2_500);
    expect(line(at(100_000), 'commission')).toBe(-5_000);
    expect(line(at(100_001), 'commission')).toBe(-10_000);
    // GST follows: 18% of the slab's referral plus the other fees.
    const top = at(100_001);
    expect(-line(top, 'feeGst')).toBe(Math.round(((10_000 + 1_500 + 2_000 + 1_900) * 18) / 100));
    for (const unit of [50_000, 50_001, 100_000, 100_001]) expect(addsUp(at(unit))).toBe(true);
  });

  it('puts TDS and TCS on the price before GST at a category\'s own rate (5%)', () => {
    const e = computeListingEconomics({ buyerPricePaise: 105_000, gstRatePercent: 5, rates: rates() });
    expect(e.exGstPaise).toBe(100_000);
    expect(line(e, 'tds')).toBe(-100);
    expect(line(e, 'tcs')).toBe(-500);
    // Clowe's fees are on the full selling price, and their GST is 18% whatever the product's rate.
    expect(line(e, 'commission')).toBe(-2_100);
    expect(-line(e, 'feeGst')).toBe(Math.round(((2_100 + 1_575 + 2_100 + 1_900) * 18) / 100));
    expect(addsUp(e)).toBe(true);
  });

  it('charges handling per unit and rounds once on the line, adding up exactly', () => {
    const e = computeListingEconomics({ buyerPricePaise: 100_000, gstRatePercent: 18, quantity: 3, rates: rates() });
    expect(line(e, 'handling')).toBe(-5_700);
    expect(line(e, 'feeGst')).toBe(-3_996); // 18% of ₹222.00
    expect(line(e, 'tds')).toBe(-254);
    expect(line(e, 'tcs')).toBe(-1_271);
    expect(e.sellerReceivesPaise).toBe(272_279);
    expect(addsUp(e)).toBe(true);
  });

  it('charges no handling fee (and so no GST on one) on Premium', () => {
    const e = computeListingEconomics({ buyerPricePaise: 100_000, gstRatePercent: 18, rates: rates({ handlingWaived: true }) });
    expect(line(e, 'handling')).toBe(0);
    expect(line(e, 'feeGst')).toBe(-990); // 18% of ₹55.00
    expect(addsUp(e)).toBe(true);
  });

  it('adds up at awkward prices', () => {
    for (const unit of [1, 99, 33_333, 77_777, 123_457, 999_999]) {
      for (const qty of [1, 2, 7]) expect(addsUp(computeListingEconomics({ buyerPricePaise: unit, gstRatePercent: 18, quantity: qty, rates: rates() })), `${unit}×${qty}`).toBe(true);
    }
  });
});

describe('CGST + SGST or IGST', () => {
  const CLOWE = '07AAAAA0000A1Z5'; // a Delhi GSTIN

  it('reads a registered seller\'s state from their GSTIN, an unregistered one\'s from their address', () => {
    expect(recipientStateCode({ gstNumber: '29ABCDE1234F1Z5', state: 'Delhi' })).toBe('29');
    expect(recipientStateCode({ gstNumber: null, state: 'NCT of Delhi' })).toBe('07');
    expect(gstStateCodeOf('Tamil Nadu')).toBe('33');
    expect(gstStateCodeOf('Jammu & Kashmir')).toBe('01');
    expect(gstStateCodeOf('Atlantis')).toBeNull();
  });

  it('is intra-state only in Clowe\'s own state; unknown counts as inter-state', () => {
    expect(isIntraStateSupply(CLOWE, { gstNumber: '07ABCDE1234F1Z5' })).toBe(true);
    expect(isIntraStateSupply(CLOWE, { gstNumber: null, state: 'Delhi' })).toBe(true);
    expect(isIntraStateSupply(CLOWE, { gstNumber: '29ABCDE1234F1Z5', state: 'Delhi' })).toBe(false);
    expect(isIntraStateSupply(CLOWE, { gstNumber: null, state: '' })).toBe(false);
  });

  it('splits into halves (the odd paisa on SGST), or all IGST', () => {
    expect(splitGst(1_333, true)).toEqual({ cgstPaise: 666, sgstPaise: 667, igstPaise: 0 });
    expect(splitGst(1_333, false)).toEqual({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1_333 });
  });
});

describe('invoice numbers', () => {
  it('runs per financial year, April to March', () => {
    expect(financialYearOf('2026-04')).toBe('2026-27');
    expect(financialYearOf('2027-03')).toBe('2026-27');
    expect(financialYearOf('2027-04')).toBe('2027-28');
  });

  it('reads CLW/2627/000001 and never passes 16 characters', () => {
    expect(sellerInvoiceNumber('CLW', '2026-27', 1)).toBe('CLW/2627/000001');
    expect(sellerInvoiceNumber('CLWS', '2026-27', 999_999)).toHaveLength(16);
    expect(() => sellerInvoiceNumber('CLOWE', '2026-27', 1)).toThrow(/16 characters/);
    expect(() => sellerInvoiceNumber('CLWS', '2026-27', 1_000_000)).toThrow(/16 characters/);
  });
});
