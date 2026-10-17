/**
 * Code 128 barcodes for shipping labels: the AWB and the order number, which
 * Delhivery's sorting scanners read (its packaging guidelines ask for both,
 * at least 8 mm tall with bars no thinner than 8 mil).
 *
 * An all-digit value of even length uses code set C (two digits a symbol, so
 * a 14-digit AWB stays short); anything else printable uses code set B.
 * The result is a run of bar/space widths in modules, starting with a bar,
 * without the quiet zones — the renderer leaves those blank.
 */

/** Bar, space, bar, space, bar, space widths of symbols 0–105; 106 is the stop (with its final bar). */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const START_C = 105;
const STOP = 106;

/** The symbol values for `value`, start and check symbol included, stop excluded. */
export function code128Symbols(value: string): number[] {
  if (value.length === 0) throw new Error('Nothing to encode');
  let symbols: number[];
  if (/^\d+$/.test(value) && value.length % 2 === 0) {
    symbols = [START_C];
    for (let i = 0; i < value.length; i += 2) symbols.push(Number(value.slice(i, i + 2)));
  } else {
    symbols = [START_B];
    for (const ch of value) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code > 126) throw new Error(`Code 128 B can't encode ${JSON.stringify(ch)}`);
      symbols.push(code - 32);
    }
  }
  const check = symbols.reduce((sum, v, i) => sum + v * Math.max(i, 1), 0) % 103;
  return [...symbols, check];
}

/** Bar/space widths in modules for `value`, ready to draw: bar first, quiet zones not included. */
export function code128Widths(value: string): number[] {
  return [...code128Symbols(value), STOP].flatMap((s) => Array.from(CODE128_PATTERNS[s]!, Number));
}
