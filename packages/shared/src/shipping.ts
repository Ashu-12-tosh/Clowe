// ---------------------------------------------------------------------------
// Parcel weight and size.
//
// Couriers bill the larger of the actual weight and the volumetric weight —
// the space the box takes, as weight: L × W × H in cm ÷ 5000, in kg. In the
// units listings store (mm, g) that is simply L × W × H ÷ 5000.
// ---------------------------------------------------------------------------

/** cm³ per kg: the courier standard for volumetric weight. */
export const VOLUMETRIC_DIVISOR = 5000;

/**
 * What a listing's parcel may weigh and measure. Wide enough for appliances
 * and furniture, narrow enough to catch a grams-for-kilograms slip or a zero.
 */
export const SHIPPING_LIMITS = {
  minWeightGrams: 10,
  maxWeightGrams: 100_000,
  minSideMm: 10,
  maxSideMm: 3_000,
} as const;

/** Volumetric weight in grams from sides in mm, or null until all three are known. */
export function volumetricWeightGrams(
  lengthMm: number | null | undefined,
  widthMm: number | null | undefined,
  heightMm: number | null | undefined,
): number | null {
  if (!lengthMm || !widthMm || !heightMm) return null;
  return Math.round((lengthMm * widthMm * heightMm) / VOLUMETRIC_DIVISOR);
}

/** The weight a courier charges for: the larger of actual and volumetric. */
export function billedWeightGrams(actualGrams: number | null | undefined, volumetricGrams: number | null): number | null {
  if (!actualGrams && !volumetricGrams) return null;
  return Math.max(actualGrams ?? 0, volumetricGrams ?? 0);
}

/** A box much bigger than the item: shipping would be charged on space, not weight. */
export function oversizedBox(actualGrams: number | null | undefined, volumetricGrams: number | null): boolean {
  return !!actualGrams && volumetricGrams !== null && volumetricGrams > 2 * actualGrams;
}

export interface ParcelInput {
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
}

/** What is missing or out of range, in words for the seller; empty when the parcel is ready for review. */
export function parcelProblems(p: ParcelInput): string[] {
  const problems: string[] = [];
  const kg = (g: number) => `${g / 1000} kg`;
  const cm = (mm: number) => `${mm / 10} cm`;
  if (!p.weightGrams) problems.push('the item weight');
  else if (p.weightGrams < SHIPPING_LIMITS.minWeightGrams || p.weightGrams > SHIPPING_LIMITS.maxWeightGrams) {
    problems.push(`a weight between ${kg(SHIPPING_LIMITS.minWeightGrams)} and ${kg(SHIPPING_LIMITS.maxWeightGrams)}`);
  }
  const sides: [string, number | null | undefined][] = [
    ['length', p.lengthMm],
    ['width', p.widthMm],
    ['height', p.heightMm],
  ];
  for (const [name, mm] of sides) {
    if (!mm) problems.push(`the ${name}`);
    else if (mm < SHIPPING_LIMITS.minSideMm || mm > SHIPPING_LIMITS.maxSideMm) {
      problems.push(`a ${name} between ${cm(SHIPPING_LIMITS.minSideMm)} and ${cm(SHIPPING_LIMITS.maxSideMm)}`);
    }
  }
  return problems;
}
