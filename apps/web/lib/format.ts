/** Format paise as Indian rupees, e.g. 149900 → "₹1,499". */
export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** Discount percentage off MRP, e.g. (999, 1499) → 33. */
export function discountPercent(pricePaise: number, mrpPaise: number | null): number | null {
  if (!mrpPaise || mrpPaise <= pricePaise) return null;
  return Math.round(((mrpPaise - pricePaise) / mrpPaise) * 100);
}
