/** Format paise as Indian rupees, e.g. 149900 → "₹1,499". */
export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** "4 Oct", by the Indian calendar the app's periods are counted in. */
export function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/**
 * Name a period sent by the API: "1–4 Oct", "28 Sep – 4 Oct", "1 Jan – 4 Oct
 * 2025". `to` is exclusive (or "now"), so the last day named is the one just
 * before it. The year is spelled out when it is not this one.
 */
export function istRange(from: string, to: string): string {
  const start = new Date(from);
  const end = new Date(Math.max(start.getTime(), new Date(to).getTime() - 1));
  const parts = (d: Date) => {
    const out: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    }).formatToParts(d)) {
      out[p.type] = p.value;
    }
    return out;
  };
  const a = parts(start);
  const b = parts(end);
  const year = b.year !== parts(new Date()).year ? ` ${b.year}` : '';
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${a.month} – ${b.day} ${b.month}${year}`;
  if (a.day !== b.day) return `${a.day}–${b.day} ${b.month}${year}`;
  return `${b.day} ${b.month}${year}`;
}

/** Discount percentage off MRP, e.g. (999, 1499) → 33. */
export function discountPercent(pricePaise: number, mrpPaise: number | null): number | null {
  if (!mrpPaise || mrpPaise <= pricePaise) return null;
  return Math.round(((mrpPaise - pricePaise) / mrpPaise) * 100);
}
