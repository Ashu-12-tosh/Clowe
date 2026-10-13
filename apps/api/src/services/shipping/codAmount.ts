// ---------------------------------------------------------------------------
// What each line of an order is worth to the buyer, out of what they pay.
//
// The order total (after coupon and credits, with the delivery fee) is spread
// over every line in proportion to its own price less its promotion, the
// paise left over going to the largest remainders. The shares add up to the
// total exactly and never depend on when a line was booked, so the parcels of
// a multi-seller COD order together collect what the buyer owes, and a line
// cancelled before shipping is simply never collected.
// ---------------------------------------------------------------------------

export interface LineValue {
  id: string;
  pricePaise: number;
  quantity: number;
  promoDiscountPaise: number;
}

export function lineShares(totalPaise: number, lines: LineValue[]): Map<string, number> {
  const shares = new Map<string, number>();
  if (lines.length === 0) return shares;
  const weights = lines.map((l) => Math.max(0, l.pricePaise * l.quantity - l.promoDiscountPaise));
  const sum = weights.reduce((a, b) => a + b, 0);
  const total = Math.max(0, totalPaise);
  if (sum === 0) {
    // Nothing priced: split evenly.
    const each = Math.floor(total / lines.length);
    lines.forEach((l, i) => shares.set(l.id, each + (i < total - each * lines.length ? 1 : 0)));
    return shares;
  }
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  lines.forEach((l, i) => shares.set(l.id, floors[i]!));
  return shares;
}

/** The buyer's value of `lineIds`, out of an order total spread over `allLines`. */
export function valueOfLines(totalPaise: number, allLines: LineValue[], lineIds: Iterable<string>): number {
  const shares = lineShares(totalPaise, allLines);
  let sum = 0;
  for (const id of lineIds) sum += shares.get(id) ?? 0;
  return sum;
}
