// ---------------------------------------------------------------------------
// Uploaded images come in a few widths, so each slot loads only what it needs.
//
// The API stores every public upload as WebP copies named <base>-w<width>.webp
// for each width below (never wider than the original), and returns the URL
// of the largest one. These helpers pick a smaller copy from that URL. Any
// other URL (older uploads, outside links) is used as it is.
// ---------------------------------------------------------------------------

/** The widths an upload is stored at. */
export const IMAGE_WIDTHS = [320, 800, 1600, 2000] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

const VARIANT = /^(.*)-w(320|800|1600|2000)\.webp$/;

/** The widths stored for this URL, smallest first; null when it isn't a stored upload. */
function variantsOf(url: string): { base: string; widths: ImageWidth[] } | null {
  const m = VARIANT.exec(url);
  if (!m || !m[1]!.includes('/uploads/')) return null;
  const largest = Number(m[2]) as ImageWidth;
  return { base: m[1]!, widths: IMAGE_WIDTHS.filter((w) => w <= largest) };
}

/** The copy to load for a slot this many pixels wide (CSS px × 2 for sharp screens is the caller's call). */
export function imageAt(url: string, width: number): string;
export function imageAt(url: string | null | undefined, width: number): string | null;
export function imageAt(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  const v = variantsOf(url);
  if (!v) return url;
  const w = v.widths.find((x) => x >= width) ?? v.widths[v.widths.length - 1]!;
  return `${v.base}-w${w}.webp`;
}

/** A srcset of every stored copy ("…-w320.webp 320w, …"), or undefined for any other URL. */
export function imageSrcSet(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const v = variantsOf(url);
  if (!v || v.widths.length < 2) return undefined;
  return v.widths.map((w) => `${v.base}-w${w}.webp ${w}w`).join(', ');
}

/**
 * Props for an <img>: a sensible default copy, the srcset, and the slot's
 * size, so the browser picks. `sizes` is the CSS width of the slot, e.g.
 * "(max-width: 640px) 50vw, 300px".
 */
export function responsiveImage(url: string, sizes: string, fallbackWidth = 800) {
  const srcSet = imageSrcSet(url);
  return srcSet ? { src: imageAt(url, fallbackWidth), srcSet, sizes } : { src: url };
}
