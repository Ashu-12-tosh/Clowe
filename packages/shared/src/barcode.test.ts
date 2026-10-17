import { describe, expect, it } from 'vitest';
import { CODE128_PATTERNS, code128Symbols, code128Widths } from './barcode';

describe('Code 128 for shipping labels', () => {
  it('has the 107 standard patterns: 11 modules each (stop 13), even bar widths, all different', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((p, i) => {
      const w = Array.from(p, Number);
      expect(w.reduce((a, b) => a + b, 0), `symbol ${i}`).toBe(i === 106 ? 13 : 11);
      // Code 128's parity rule: the bars of every symbol add up to an even width.
      if (i < 106) expect((w[0]! + w[2]! + w[4]!) % 2, `symbol ${i}`).toBe(0);
    });
  });

  it('packs an all-digit AWB two digits a symbol (code set C), with the weighted check symbol', () => {
    // Start C (105), 67 86 47 10 00 00 11, then (105 + 67·1 + 86·2 + 47·3 + 10·4 + 0·5 + 0·6 + 11·7) mod 103.
    const check = (105 + 67 + 86 * 2 + 47 * 3 + 10 * 4 + 0 + 0 + 11 * 7) % 103;
    expect(code128Symbols('67864710000011')).toEqual([105, 67, 86, 47, 10, 0, 0, 11, check]);
  });

  it('encodes an order number in code set B', () => {
    // "PJJ123C": start B (104), then ASCII − 32 per character; the check weights each by its position.
    expect(code128Symbols('PJJ123C')).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 879 % 103]);
    expect(code128Symbols('CLW-2026-000123')[0]).toBe(104);
    // An odd number of digits can't pair up: code set B.
    expect(code128Symbols('123')[0]).toBe(104);
  });

  it('draws bar first and ends on the stop pattern, the width a scanner expects', () => {
    const w = code128Widths('67864710000011');
    // Start, 7 digit pairs, check: 9 symbols of 11 modules, plus the 13-module stop.
    expect(w.reduce((a, b) => a + b, 0)).toBe(9 * 11 + 13);
    expect(w.slice(0, 6).join('')).toBe('211232');
    expect(w.slice(-7).join('')).toBe('2331112');
  });

  it('refuses what Code 128 B cannot carry', () => {
    expect(() => code128Symbols('')).toThrow();
    expect(() => code128Symbols('₹100')).toThrow();
  });
});
