/**
 * Age gate for try-on on children's clothing.
 *
 * Kids clothing is sized by age — "2-3Y", "4-5Y", "6-7Y" — so the size tells
 * us how old the wearer is. Try-on renders a real person's photo wearing the
 * garment, and we do not generate those for young children: anything sized
 * below TRYON_MIN_AGE_YEARS is refused.
 *
 * The gate is applied to the *size being tried on*, not to the listing as a
 * whole. A t-shirt sold in 4-5Y, 6-7Y and 8-9Y stays available — picking 6-7Y
 * works, picking 4-5Y does not — so a parent shopping for an eight-year-old is
 * not blocked by the existence of a smaller size. A listing is only hidden
 * from try-on entirely when every size it offers is under the cut-off.
 *
 * This gates the *garment*, not the photo — nothing here can tell how old the
 * person in an uploaded picture is. It is the practical control: you try a
 * 2-3Y frock on with a photo of a 2-3 year old.
 */

/** A garment must be sized for at least this age to be tried on. */
export const TRYON_MIN_AGE_YEARS = 5;

/**
 * Age in years a size label starts at, or null when the label carries no age.
 *
 * Handles the spellings Indian kids' sizing actually uses:
 *   "4-5Y", "4-5 Years", "4Y", "8-9y", "0-3M" / "6 Months" (months -> years),
 *   "2T" (toddler). Adult labels ("M", "XL", "32") yield null.
 */
export function minAgeFromSizeLabel(label: string): number | null {
  const text = label.toLowerCase().trim();
  if (!text) return null;

  // Months first: "0-3M", "6 months" — anything in months is under a year.
  const months = text.match(/(\d+)\s*(?:-\s*\d+\s*)?(?:m\b|mo\b|month)/);
  if (months) return Number(months[1]) / 12;

  // "2T" / "3T" toddler sizing.
  const toddler = text.match(/^(\d+)\s*t$/);
  if (toddler) return Number(toddler[1]);

  // "4-5Y", "4 - 5 years", "4Y", "4 yr".
  const years = text.match(/(\d+)\s*(?:-\s*\d+\s*)?(?:y\b|yr|year)/);
  if (years) return Number(years[1]);

  return null;
}

/** True when this exact size is below the cut-off. Adult sizes are never below it. */
export function isSizeBelowTryOnAge(size: string | null | undefined): boolean {
  if (!size) return false;
  const age = minAgeFromSizeLabel(size);
  return age !== null && age < TRYON_MIN_AGE_YEARS;
}

/**
 * True when *no* size this listing offers is old enough, so try-on should not
 * be advertised on it at all. A listing with a mix keeps the feature; the
 * per-size check refuses the individual sizes that are too young.
 *
 * Listings with no age-based sizes (adult clothing) are never blocked here.
 */
export function isListingBelowTryOnAge(sizes: (string | null | undefined)[]): boolean {
  const ages = sizes
    .map((size) => (size ? minAgeFromSizeLabel(size) : null))
    .filter((age): age is number => age !== null);
  if (ages.length === 0) return false;
  return ages.every((age) => age < TRYON_MIN_AGE_YEARS);
}
