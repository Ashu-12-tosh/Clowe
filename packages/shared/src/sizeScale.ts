// ---------------------------------------------------------------------------
// Size scales
//
// One `size` key carries every scale the catalog sells in: S/M/L, waists in
// inches, UK shoe sizes, children's age bands, watch cases in mm, cookware in
// cm, screens in inches and "Free Size". Splitting the key would break the
// filters, the URLs and the options key that already depend on it, so a
// facet instead asks which scale a value is on and sorts within and across
// scales with compareSizes().
// ---------------------------------------------------------------------------

export const SIZE_SCALES = ['alpha', 'waist', 'uk', 'age', 'length_mm', 'length_cm', 'inch', 'free', 'other'] as const;
export type SizeScale = (typeof SIZE_SCALES)[number];

/** Letter sizes in wearing order; "2XL" and "XXL" are the same size. */
const ALPHA_ORDER = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '4xl', '5xl', '6xl'];
const ALPHA_ALIASES: Record<string, string> = { '2xl': 'xxl', '3xl': 'xxxl' };

const FREE_SIZE_WORDS = new Set(['free size', 'free', 'one size', 'onesize', 'os', 'free-size']);

const UK_RE = /^uk\s*(\d+(?:\.\d+)?)$/;
/** "2-3Y", "4-5 yrs", "0-3M", "12 months": the first number is the lower bound. */
const AGE_RE = /^(\d+)(?:\s*-\s*\d+)?\s*(y|yr|yrs|years?|m|mo|months?)$/;
const MM_RE = /^(\d+(?:\.\d+)?)\s*mm$/;
const CM_RE = /^(\d+(?:\.\d+)?)\s*cm$/;
const INCH_RE = /^(\d+(?:\.\d+)?)\s*(?:inch|inches|in|")$/;
/** A bare number is a waist in inches — the only bare-number scale the catalog uses. */
const BARE_NUMBER_RE = /^(\d+(?:\.\d+)?)$/;
const MONTHS_PER_YEAR = 12;

function canonical(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function alphaIndex(value: string): number {
  return ALPHA_ORDER.indexOf(ALPHA_ALIASES[value] ?? value);
}

export function sizeScaleOf(value: string): SizeScale {
  const v = canonical(value);
  if (!v) return 'other';
  if (FREE_SIZE_WORDS.has(v)) return 'free';
  if (alphaIndex(v) !== -1) return 'alpha';
  if (UK_RE.test(v)) return 'uk';
  if (AGE_RE.test(v)) return 'age';
  if (MM_RE.test(v)) return 'length_mm';
  if (CM_RE.test(v)) return 'length_cm';
  if (INCH_RE.test(v)) return 'inch';
  if (BARE_NUMBER_RE.test(v)) return 'waist';
  return 'other';
}

/** Position within the scale: letter index, number, or age lower bound in months. */
function sizeRank(value: string, scale: SizeScale): number {
  const v = canonical(value);
  switch (scale) {
    case 'alpha':
      return alphaIndex(v);
    case 'uk':
      return Number(UK_RE.exec(v)![1]);
    case 'age': {
      const [, lower, unit] = AGE_RE.exec(v)!;
      return unit.startsWith('y') ? Number(lower) * MONTHS_PER_YEAR : Number(lower);
    }
    case 'length_mm':
      return Number(MM_RE.exec(v)![1]);
    case 'length_cm':
      return Number(CM_RE.exec(v)![1]);
    case 'inch':
      return Number(INCH_RE.exec(v)![1]);
    case 'waist':
      return Number(v);
    default:
      return 0;
  }
}

/**
 * Orders sizes the way a shopper reads them: scales in the fixed SIZE_SCALES
 * order (letters, waists, UK, ages, mm, cm, inches, free, the rest), then
 * XS < S < M < L < XL < XXL, numbers numerically, ages by lower bound, and
 * whatever is left alphabetically.
 */
export function compareSizes(a: string, b: string): number {
  const scaleA = sizeScaleOf(a);
  const scaleB = sizeScaleOf(b);
  if (scaleA !== scaleB) return SIZE_SCALES.indexOf(scaleA) - SIZE_SCALES.indexOf(scaleB);
  const rank = sizeRank(a, scaleA) - sizeRank(b, scaleB);
  if (rank !== 0) return rank;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
