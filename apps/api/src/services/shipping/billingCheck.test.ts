import { describe, expect, it } from 'vitest';
import { DEFAULT_DELHIVERY_BILLING_COLUMNS, resolveBillingColumns, type DelhiveryBillingColumns } from '@clowe/shared';
import { chargesFor, classifyCharge, readBillingFile, rupeesToPaise, weightToGrams, type BillingRow } from './billingCheck';

/**
 * Reading Delhivery's billing export. Its real column names are not known to
 * us, so the header is read from guesses or the admin's own choice; amounts
 * are rupees, made paise with GST included, as the ledger's are.
 */

const cols = (over: Partial<DelhiveryBillingColumns> = {}): DelhiveryBillingColumns => ({ ...DEFAULT_DELHIVERY_BILLING_COLUMNS, ...over });
const inclGst = cols({ amountsIncludeGst: true });

describe('cells', () => {
  it('reads rupees as paise, whatever the formatting', () => {
    expect(rupeesToPaise('70')).toBe(7_000);
    expect(rupeesToPaise(' ₹1,234.50 ')).toBe(123_450);
    expect(rupeesToPaise('Rs. 82.6')).toBe(8_260);
    expect(rupeesToPaise('(12.50)')).toBe(-1_250);
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('-')).toBeNull();
    expect(rupeesToPaise(undefined)).toBeNull();
    expect(rupeesToPaise('n/a')).toBeNaN();
  });

  it('reads the weight in the configured unit, unless the cell says its own', () => {
    expect(weightToGrams('0.5', 'KG')).toBe(500);
    expect(weightToGrams('1.25', 'KG')).toBe(1_250);
    expect(weightToGrams('500', 'GRAMS')).toBe(500);
    expect(weightToGrams('500 g', 'KG')).toBe(500);
    expect(weightToGrams('2 kg', 'GRAMS')).toBe(2_000);
    expect(weightToGrams('', 'KG')).toBeNull();
    expect(weightToGrams('heavy-ish', 'KG')).toBeNaN();
  });
});

describe('the header', () => {
  it('finds each field by its guesses, without case, spaces or punctuation', () => {
    const at = resolveBillingColumns(['waybill no.', 'CHARGED WEIGHT', 'Freight Charges', 'RTO Amount', 'Reverse Charges', 'GST Amount'], cols());
    expect(at).toEqual({ awb: 0, weight: 1, forward: 2, rto: 3, dto: 4, total: -1, gst: 5 });
    expect(resolveBillingColumns(['AWB Number'], cols()).awb).toBe(0);
    expect(resolveBillingColumns(['AWB'], cols()).awb).toBe(0);
  });

  it("prefers the admin's chosen column, and falls back to the guesses when the file hasn't got it", () => {
    expect(resolveBillingColumns(['Waybill', 'Shipment Ref'], cols({ awb: 'shipment ref' })).awb).toBe(1);
    expect(resolveBillingColumns(['Waybill'], cols({ awb: 'Shipment Ref' })).awb).toBe(0);
  });

  it('refuses a file with no AWB column, naming the columns it has', () => {
    expect(() => readBillingFile('Consignment,Amount\n1,70\n', inclGst)).toThrow(/AWB column.*"Consignment", "Amount"/);
  });

  it('refuses a file with no charge column', () => {
    expect(() => readBillingFile('Waybill,Status\n1,Delivered\n', inclGst)).toThrow(/charge column/);
  });

  it('refuses a file with nothing under the header', () => {
    expect(() => readBillingFile('Waybill,Freight\n', inclGst)).toThrow(/no rows/);
  });
});

describe('rows', () => {
  it('reads each charge, and the weight, when the amounts include GST', () => {
    const f = readBillingFile('Waybill,Charged Weight,Freight,RTO Charges,DTO Charges\n111,0.5,82.60,,\n222,1,100,59,\n', inclGst);
    expect(f.rows).toEqual([
      { row: 2, awb: '111', forwardPaise: 8_260, rtoPaise: null, dtoPaise: null, weightGrams: 500 },
      { row: 3, awb: '222', forwardPaise: 10_000, rtoPaise: 5_900, dtoPaise: null, weightGrams: 1_000 },
    ]);
    expect(f.columnsUsed).toMatchObject({ awb: 'Waybill', weight: 'Charged Weight', forward: 'Freight', rto: 'RTO Charges', dto: 'DTO Charges', total: null, gst: null });
  });

  it('adds 18 % to amounts before GST when the file has no GST column', () => {
    const f = readBillingFile('AWB,Freight\n111,70\n', cols());
    expect(f.rows[0]!.forwardPaise).toBe(8_260);
  });

  it("adds the row's GST column, shared across its charges, to amounts before GST", () => {
    const f = readBillingFile('AWB,Freight,RTO Charges,GST\n111,70,,12.60\n222,100,50,27\n', cols());
    expect(f.rows[0]).toMatchObject({ forwardPaise: 8_260, rtoPaise: null });
    // ₹27 GST over ₹100 + ₹50: ₹18 and ₹9.
    expect(f.rows[1]).toMatchObject({ forwardPaise: 11_800, rtoPaise: 5_900 });
  });

  it('reads a total as the parcel’s one charge when there is no forward, RTO or return column', () => {
    const f = readBillingFile('AWB,Total Amount\n111,82.6\n', inclGst);
    expect(f.rows[0]!.forwardPaise).toBe(8_260);
    // With a forward column, the total is left alone.
    expect(readBillingFile('AWB,Freight,Total\n111,70,999\n', inclGst).rows[0]!.forwardPaise).toBe(7_000);
  });

  it('skips, and says why, rows with no AWB, no charge, or a cell that is not a number', () => {
    const f = readBillingFile("AWB,Freight\n,70\n'333,0\n444,abc\n555,10\n", inclGst);
    expect(f.rows.map((r) => r.awb)).toEqual(['555']);
    expect(f.skipped).toEqual([
      { row: 2, reason: 'No AWB' },
      { row: 3, reason: 'AWB 333: no charge on this row' },
      { row: 4, reason: 'AWB 444: an amount or the weight is not a number' },
    ]);
  });

  it('reads grams when the mapping says so', () => {
    const f = readBillingFile('AWB,Weight,Freight\n111,750,70\n', cols({ weightUnit: 'GRAMS', amountsIncludeGst: true }));
    expect(f.rows[0]!.weightGrams).toBe(750);
  });
});

describe('charges per trip', () => {
  const row = (over: Partial<BillingRow>): BillingRow => ({ row: 2, awb: '111', forwardPaise: null, rtoPaise: null, dtoPaise: null, weightGrams: null, ...over });

  it('makes a line per AWB and trip, summing repeated rows, with the weight on the forward trip', () => {
    const charges = chargesFor(
      [row({ forwardPaise: 7_000, rtoPaise: 5_000, weightGrams: 500 }), row({ forwardPaise: 1_000, weightGrams: 1_000 }), row({ awb: '222', dtoPaise: 6_000 })],
      () => 'FORWARD',
    );
    expect(charges).toEqual([
      { awb: '111', kind: 'FORWARD', billedPaise: 8_000, billedWeightGrams: 1_000 },
      { awb: '111', kind: 'RTO', billedPaise: 5_000, billedWeightGrams: null },
      { awb: '222', kind: 'DTO', billedPaise: 6_000, billedWeightGrams: null },
    ]);
  });

  it("bills a customer return's own AWB as its return pickup, whichever column it is in", () => {
    const charges = chargesFor([row({ forwardPaise: 6_000, weightGrams: 500 })], () => 'REVERSE');
    expect(charges).toEqual([{ awb: '111', kind: 'DTO', billedPaise: 6_000, billedWeightGrams: 500 }]);
  });

  it('leaves out a trip whose rows cancel out', () => {
    expect(chargesFor([row({ forwardPaise: 7_000 }), row({ forwardPaise: -7_000 })], () => 'FORWARD')).toEqual([]);
  });
});

describe('against the ledger', () => {
  const base = { known: true, billedPaise: 8_260, billedWeightGrams: 500, ledgerPaise: 8_260, ledgerWeightGrams: 500 };

  it('matches when the amount and weight agree, or a weight is missing', () => {
    expect(classifyCharge(base)).toEqual({ status: 'MATCHED', differencePaise: 0 });
    expect(classifyCharge({ ...base, ledgerWeightGrams: null })).toEqual({ status: 'MATCHED', differencePaise: 0 });
  });

  it('flags a different amount: + the seller owes more, − they are owed', () => {
    expect(classifyCharge({ ...base, ledgerPaise: 7_000 })).toEqual({ status: 'MISMATCH', differencePaise: 1_260 });
    expect(classifyCharge({ ...base, ledgerPaise: 9_000 })).toEqual({ status: 'MISMATCH', differencePaise: -740 });
  });

  it('flags a different weight even when the amount agrees', () => {
    expect(classifyCharge({ ...base, billedWeightGrams: 1_000 })).toEqual({ status: 'MISMATCH', differencePaise: 0 });
  });

  it('a trip nothing was charged for yet is the whole bill; an AWB that is not ours too', () => {
    expect(classifyCharge({ ...base, ledgerPaise: null })).toEqual({ status: 'NOT_ON_LEDGER', differencePaise: 8_260 });
    expect(classifyCharge({ ...base, known: false, ledgerPaise: null })).toEqual({ status: 'UNKNOWN_AWB', differencePaise: 8_260 });
  });
});
