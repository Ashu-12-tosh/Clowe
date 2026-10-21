import { describe, expect, it } from 'vitest';
import { GAP_DONORS, GAP_RATES } from './categoryMapping';
import { parseFeeSheet, scheduleRates } from './sheet';
import type { SheetRow } from './xlsx';

// The four gaps in "Clowe_Referral_Fee_Schedule (6).xlsx", as the sheet has them.
const ROWS: SheetRow[] = [
  { A: 'Group', B: 'Category', C: 'Item Price Slab (INR)', D: 'Benchmark Rate', E: 'CLOWE Rate' },
  { A: 'Softline', B: 'Apparel - Shirts', C: '> 1,000', D: '0.215', E: '0.19' },
  { A: 'Softline', B: 'Apparel - Other products', C: '<= 1,000', D: '0.025', E: '0' },
  { A: 'Softline', B: 'Apparel - Other products', C: '> 1,000', D: '0.195', E: '0.17' },
  { A: 'Other Hardline', B: 'Gas Stoves and Pressure Cookers', C: '<= 1,000', D: '0.025', E: '0' },
  { A: 'Other Hardline', B: 'Gas Stoves and Pressure Cookers', C: '> 1,000 and <= 1,500', D: '0.075', E: '0.05' },
  { A: 'Other Hardline', B: 'Kitchen - Other products', C: '<= 1,000', D: '0.025', E: '0' },
  { A: 'Other Hardline', B: 'Kitchen - Other products', C: '> 1,000', D: '0.125', E: '0.1' },
  { A: 'CE/PC/Wireless', B: 'PC Components - RAM and Motherboards', C: '<= 300', D: '0', E: '0' },
  { A: 'CE/PC/Wireless', B: 'Desktops', C: 'All prices', D: '0.08', E: '0.07' },
];

describe('the owner’s gap decisions (21 Oct 2026)', () => {
  const { categories, problems } = parseFeeSheet(ROWS);
  const { rates, gaps } = scheduleRates(categories, GAP_DONORS, GAP_RATES);
  const of = (name: string) => rates.filter((r) => r.sheetCategory === name);

  it('reads the sheet without problems', () => {
    expect(problems).toEqual([]);
  });

  it('Gas Stoves above ₹1,500 borrow Kitchen - Other products: 10%', () => {
    expect(of('Gas Stoves and Pressure Cookers').map((r) => [r.slabLabel, r.rateBps, r.borrowedFrom])).toEqual([
      ['<= 1,000', 0, null],
      ['> 1,000 and <= 1,500', 500, null],
      ['> 1,500', 1_000, 'Kitchen - Other products'],
    ]);
    expect(gaps.find((g) => g.sheetCategory === 'Gas Stoves and Pressure Cookers')).toMatchObject({ borrowedFrom: 'Kitchen - Other products', chosen: true });
  });

  it('RAM and Motherboards above ₹300: 7% (as Desktops), stored as provisional', () => {
    expect(of('PC Components - RAM and Motherboards')).toEqual([
      expect.objectContaining({ slabLabel: '<= 300', rateBps: 0 }),
      expect.objectContaining({ slabLabel: '> 300', abovePaise: 30_000, upToPaise: null, rateBps: 700, provisional: true, note: 'same as Desktops', borrowedFrom: null }),
    ]);
    expect(rates.filter((r) => r.provisional)).toHaveLength(1);
  });

  it('every other gap still follows the family rule', () => {
    expect(of('Apparel - Shirts')[0]).toMatchObject({ slabLabel: '<= 1,000', rateBps: 0, borrowedFrom: 'Apparel - Other products' });
    expect(gaps.every((g) => g.borrowedFrom || g.ownerRate)).toBe(true);
  });
});
