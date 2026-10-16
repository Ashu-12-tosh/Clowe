import { describe, expect, it } from 'vitest';
import { sellerRegisterSchema } from './seller';
import { storeBusinessSchema } from './sellerStore';
import { GSTIN_EXAMPLE, PAN_EXAMPLE, gstinCheckChar, gstinProblem, isGstStateCode, panProblem } from './taxIds';

// A real, published GSTIN (Clowe's own legal entity) — its check character is GSTN's.
const REAL_GSTIN = '07AAWFC9519L1ZL';

describe('PAN', () => {
  it('is 5 letters, 4 digits, 1 letter (AAAAA9999A)', () => {
    expect(panProblem(PAN_EXAMPLE)).toBeNull();
    expect(panProblem(' abcde 1234f ')).toBeNull(); // spaces and case are forgiven
    for (const bad of ['ABCD1234F', 'ABCDE12345', '1BCDE1234F', 'ABCDE1234FF', 'ABCDE123AF', '']) {
      expect(panProblem(bad)).toMatch(/5 letters, 4 digits and a letter/);
    }
  });
});

describe('GSTIN', () => {
  it('accepts a real GSTIN and the example', () => {
    expect(gstinProblem(REAL_GSTIN)).toBeNull();
    expect(gstinProblem(GSTIN_EXAMPLE, PAN_EXAMPLE)).toBeNull();
  });

  it('computes the check character the way GSTN does', () => {
    expect(gstinCheckChar(REAL_GSTIN.slice(0, 14))).toBe('L');
    expect(gstinCheckChar(GSTIN_EXAMPLE.slice(0, 14))).toBe('W');
  });

  it('is 15 characters', () => {
    expect(gstinProblem('29ABCDE1234F1Z')).toMatch(/15 characters — this one has 14/);
    expect(gstinProblem('29ABCDE1234F1ZWW')).toMatch(/has 16/);
  });

  it('has a state code from 01 to 38', () => {
    expect(isGstStateCode('01')).toBe(true);
    expect(isGstStateCode('38')).toBe(true);
    expect(isGstStateCode('00')).toBe(false);
    expect(isGstStateCode('39')).toBe(false);
    const g = (state: string) => `${state}ABCDE1234F1Z` + gstinCheckChar(`${state}ABCDE1234F1Z`);
    expect(gstinProblem(g('00'))).toMatch(/state code from 01 to 38, not 00/);
    expect(gstinProblem(g('39'))).toMatch(/not 39/);
    expect(gstinProblem(g('38'))).toBeNull();
  });

  it("carries the seller's PAN in characters 3–12", () => {
    expect(gstinProblem(GSTIN_EXAMPLE, 'ZZZZZ9999Z')).toMatch(/carries ABCDE1234F, not your PAN ZZZZZ9999Z/);
  });

  it('refuses a typo the check character catches', () => {
    expect(gstinProblem('29ABCDE1234F1Z5')).toMatch(/typo/);
    expect(gstinProblem('29ABCDE1243F1ZW')).toMatch(/typo/); // two digits swapped
  });

  it('names what is wrong with a malformed one', () => {
    expect(gstinProblem('29ABCDE1234F1X5')).toMatch(/looks like 29ABCDE1234F1ZW/);
  });
});

const register = { shopName: 'Test Shop' };
const errorsOf = (r: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('seller registration', () => {
  it('takes valid IDs, normalised', () => {
    const r = sellerRegisterSchema.safeParse({ ...register, panNumber: 'abcde1234f', gstNumber: '29abcde1234f1zw' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ panNumber: PAN_EXAMPLE, gstNumber: GSTIN_EXAMPLE });
  });

  it('still lets both be left out', () => {
    expect(sellerRegisterSchema.safeParse(register).success).toBe(true);
  });

  it('puts each error under its own field', () => {
    const r = sellerRegisterSchema.safeParse({ ...register, panNumber: 'ABC123', gstNumber: '29ABCDE1234F1Z5' });
    expect(errorsOf(r)).toEqual({
      panNumber: expect.stringMatching(/5 letters, 4 digits/),
      gstNumber: expect.stringMatching(/typo/),
    });
  });

  it('refuses a GSTIN issued against a different PAN, once, on the GSTIN', () => {
    const r = sellerRegisterSchema.safeParse({ ...register, panNumber: 'ZZZZZ9999Z', gstNumber: GSTIN_EXAMPLE });
    expect(r.error?.issues).toHaveLength(1);
    expect(errorsOf(r)).toEqual({ gstNumber: expect.stringMatching(/not your PAN ZZZZZ9999Z/) });
  });
});

describe('Store Settings → Business', () => {
  it('holds the GSTIN and PAN to the same rule as registration', () => {
    expect(storeBusinessSchema.safeParse({ gstNumber: GSTIN_EXAMPLE, panNumber: PAN_EXAMPLE }).success).toBe(true);
    expect(storeBusinessSchema.safeParse({ gstNumber: '', panNumber: '' }).success).toBe(true);
    expect(errorsOf(storeBusinessSchema.safeParse({ gstNumber: '39ABCDE1234F1Z5' }))).toEqual({ gstNumber: expect.stringMatching(/state code/) });
    expect(errorsOf(storeBusinessSchema.safeParse({ gstNumber: GSTIN_EXAMPLE, panNumber: 'ZZZZZ9999Z' }))).toEqual({
      gstNumber: expect.stringMatching(/not your PAN/),
    });
  });
});
