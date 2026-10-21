// ---------------------------------------------------------------------------
// Referral fees by category and price slab (the owner's fee schedule,
// "Clowe_Referral_Fee_Schedule (6).xlsx", sheet "Clowe Fee Schedule").
//
// Each schedule category has slabs of the item price — the selling price per
// unit, GST included — and the rate of the slab a price falls in applies to
// the FULL price, not marginally: a ₹1,500 shirt in "Apparel - Shirts"
// (> ₹1,000: 19%) pays 19% of ₹1,500 = ₹285.
//
// A category whose slabs leave a price range uncovered borrows that range
// from its family's "… - Other products" row (Apparel - Shirts ≤ ₹1,000 →
// Apparel - Other products ≤ ₹1,000). The schedule is versioned: an order line
// keeps the rate it was placed under (OrderItem.feeRates); a new version
// applies to orders placed after it takes effect.
// ---------------------------------------------------------------------------

export interface ReferralFeeSlab {
  /** Exclusive lower bound of the unit price, in paise (0 for the first slab, which includes ₹0). */
  abovePaise: number;
  /** Inclusive upper bound, in paise; null = no upper bound. */
  upToPaise: number | null;
  /** The rate in basis points of the full item price: 19% = 1900, 0.5% = 50. */
  rateBps: number;
  /** The slab as the schedule writes it: "> 1,000", "> 250 and <= 500", "All prices". */
  label: string;
  /** A gap filled from another row: that row's schedule category. */
  borrowedFrom?: string | null;
}

export interface ReferralFeeCategory {
  group: string;
  /** The schedule's category name, e.g. "Apparel - Shirts". */
  sheetCategory: string;
  slabs: ReferralFeeSlab[];
}

/** What a line's referral fee was worked out from — kept with its fee snapshot. */
export interface ReferralFeeSource {
  scheduleVersion: number;
  sheetCategory: string;
  slabLabel: string;
  rateBps: number;
  borrowedFrom: string | null;
}

/** A rate in basis points as a percent: 1900 → 19, 50 → 0.5. */
export const bpsToPercent = (bps: number): number => bps / 100;

/** A decimal rate as the sheet stores it ("0.19", 0.005) in basis points. */
export function decimalRateToBps(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Not a rate between 0 and 1: ${value}`);
  return Math.round(n * 10_000);
}

const rupeesToPaise = (digits: string) => Number(digits.replace(/,/g, '')) * 100;

/**
 * A slab as the schedule writes it, in paise: "<= 250", "> 1,000",
 * "> 250 and <= 500", "All prices". Null when it is none of these.
 */
export function parseSlabLabel(label: string): { abovePaise: number; upToPaise: number | null } | null {
  const s = label.trim().replace(/\s+/g, ' ');
  if (/^all prices$/i.test(s)) return { abovePaise: 0, upToPaise: null };
  let m = /^<= ([\d,]+)$/.exec(s);
  if (m) return { abovePaise: 0, upToPaise: rupeesToPaise(m[1]!) };
  m = /^> ([\d,]+)$/.exec(s);
  if (m) return { abovePaise: rupeesToPaise(m[1]!), upToPaise: null };
  m = /^> ([\d,]+) and <= ([\d,]+)$/.exec(s);
  if (m) {
    const above = rupeesToPaise(m[1]!);
    const upTo = rupeesToPaise(m[2]!);
    return upTo > above ? { abovePaise: above, upToPaise: upTo } : null;
  }
  return null;
}

/** Does this slab hold a unit price? The first slab (from ₹0) holds ₹0 itself. */
export function slabHolds(slab: Pick<ReferralFeeSlab, 'abovePaise' | 'upToPaise'>, unitPaise: number): boolean {
  const aboveOk = slab.abovePaise === 0 ? unitPaise >= 0 : unitPaise > slab.abovePaise;
  return aboveOk && (slab.upToPaise === null || unitPaise <= slab.upToPaise);
}

/** The slab a unit price falls in, or null when the slabs leave it uncovered. */
export function slabFor(slabs: ReferralFeeSlab[], unitPaise: number): ReferralFeeSlab | null {
  return slabs.find((s) => slabHolds(s, unitPaise)) ?? null;
}

/** The price ranges a category's slabs leave uncovered, as [abovePaise, upToPaise | null]. */
export function slabGaps(slabs: Pick<ReferralFeeSlab, 'abovePaise' | 'upToPaise'>[]): [number, number | null][] {
  const sorted = [...slabs].sort((a, b) => a.abovePaise - b.abovePaise);
  const gaps: [number, number | null][] = [];
  let covered = 0; // everything up to and including `covered` paise is covered once a slab starts at 0
  let started = false;
  for (const s of sorted) {
    if (!started) {
      if (s.abovePaise > 0) gaps.push([0, s.abovePaise]);
      started = true;
    } else if (s.abovePaise > covered) {
      gaps.push([covered, s.abovePaise]);
    }
    if (s.upToPaise === null) return gaps;
    covered = Math.max(covered, s.upToPaise);
  }
  gaps.push([covered, null]);
  return gaps;
}

const OTHER_PRODUCTS = / - Other products$/i;

/**
 * The row a gap borrows from: the same group's "<family> - Other products"
 * whose family begins the category's name — "Apparel - Shirts" → "Apparel -
 * Other products", "Pet comforters including …" → "Pet - Other products".
 * The longest family wins; null when the group has none that fits.
 */
export function otherProductsDonorFor(
  category: Pick<ReferralFeeCategory, 'group' | 'sheetCategory'>,
  all: Iterable<ReferralFeeCategory>,
): ReferralFeeCategory | null {
  const name = category.sheetCategory.trim().toLowerCase();
  let best: ReferralFeeCategory | null = null;
  let bestLength = 0;
  for (const c of all) {
    if (c.group !== category.group || !OTHER_PRODUCTS.test(c.sheetCategory) || c.sheetCategory === category.sheetCategory) continue;
    const family = c.sheetCategory.replace(OTHER_PRODUCTS, '').trim().toLowerCase();
    const fits = name === family || name.startsWith(`${family} `) || name.startsWith(`${family}-`);
    if (fits && family.length > bestLength) {
      best = c;
      bestLength = family.length;
    }
  }
  return best;
}

/**
 * The category's slabs with every gap filled from its family's "… - Other
 * products" row (otherProductsDonorFor), or from `donorOverride` when the
 * owner picked one. Gaps no row covers are returned as they are, for the
 * import to list.
 */
export function fillSlabGaps(
  category: ReferralFeeCategory,
  bySheetCategory: Map<string, ReferralFeeCategory>,
  donorOverride?: string | null,
): { slabs: ReferralFeeSlab[]; unfilled: [number, number | null][]; donor: string | null } {
  const gaps = slabGaps(category.slabs);
  if (gaps.length === 0) return { slabs: [...category.slabs].sort((a, b) => a.abovePaise - b.abovePaise), unfilled: [], donor: null };
  const donor = donorOverride ? (bySheetCategory.get(donorOverride) ?? null) : otherProductsDonorFor(category, bySheetCategory.values());
  const slabs = [...category.slabs];
  const unfilled: [number, number | null][] = [];
  for (const [from, to] of gaps) {
    if (!donor) {
      unfilled.push([from, to]);
      continue;
    }
    // The donor's slabs, clipped to the gap.
    let filledTo: number | null = from;
    for (const d of [...donor.slabs].sort((a, b) => a.abovePaise - b.abovePaise)) {
      const lo = Math.max(from, d.abovePaise);
      const hi = to === null ? d.upToPaise : d.upToPaise === null ? to : Math.min(to, d.upToPaise);
      if (hi !== null && hi <= lo) continue;
      slabs.push({ abovePaise: lo, upToPaise: hi, rateBps: d.rateBps, label: slabLabelOf(lo, hi), borrowedFrom: donor.sheetCategory });
      filledTo = hi;
      if (hi === null) break;
    }
    if (filledTo !== null && (to === null || filledTo < to)) unfilled.push([filledTo, to]);
  }
  return { slabs: slabs.sort((a, b) => a.abovePaise - b.abovePaise), unfilled, donor: donor?.sheetCategory ?? null };
}

const rupees = (paise: number) => (paise / 100).toLocaleString('en-IN');

/** A slab in the schedule's own words, from its bounds. */
export function slabLabelOf(abovePaise: number, upToPaise: number | null): string {
  if (abovePaise === 0 && upToPaise === null) return 'All prices';
  if (abovePaise === 0) return `<= ${rupees(upToPaise!)}`;
  if (upToPaise === null) return `> ${rupees(abovePaise)}`;
  return `> ${rupees(abovePaise)} and <= ${rupees(upToPaise)}`;
}

/** A slab for people: "up to ₹1,000", "above ₹1,000", "₹250 – ₹500", "any price". */
export function slabDescription(slab: Pick<ReferralFeeSlab, 'abovePaise' | 'upToPaise'>): string {
  if (slab.abovePaise === 0 && slab.upToPaise === null) return 'any price';
  if (slab.abovePaise === 0) return `up to ₹${rupees(slab.upToPaise!)}`;
  if (slab.upToPaise === null) return `above ₹${rupees(slab.abovePaise)}`;
  return `above ₹${rupees(slab.abovePaise)} up to ₹${rupees(slab.upToPaise)}`;
}

/**
 * The referral percent for a unit price (GST included) under these slabs, or
 * the flat fallback when there are none or none holds the price.
 */
export function referralPercentFor(
  slabs: ReferralFeeSlab[] | null | undefined,
  unitPaise: number,
  fallbackPercent: number,
): { percent: number; slab: ReferralFeeSlab | null } {
  const slab = slabs?.length ? slabFor(slabs, unitPaise) : null;
  return slab ? { percent: bpsToPercent(slab.rateBps), slab } : { percent: fallbackPercent, slab: null };
}
