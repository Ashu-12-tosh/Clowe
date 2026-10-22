/**
 * The Clowe Shop wordmark. Black on light backgrounds, white or gold on dark
 * ones. A vector (SVG) — sharp at any size; the PNGs beside it in
 * /public/brand are for places that cannot show SVG (emails).
 */
export type BrandTone = 'black' | 'white' | 'gold';

/** Width ÷ height of the trimmed wordmark (public/brand/wordmark-*.svg). */
export const WORDMARK_RATIO = 3.95;

export default function BrandLogo({
  tone = 'black',
  height = 32,
  className = '',
}: {
  tone?: BrandTone;
  /** Rendered height in CSS pixels; the width follows the wordmark's shape. */
  height?: number;
  className?: string;
}) {
  return (
    // A static file from /public: next/image would only add a loader to a vector.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/brand/wordmark-${tone}.svg`}
      alt="Clowe Shop"
      width={Math.round(height * WORDMARK_RATIO)}
      height={height}
      className={`block h-auto max-w-full select-none ${className}`}
      draggable={false}
    />
  );
}

/** The round mark alone, for tight spaces (collapsed sidebars, badges). */
export function BrandIcon({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/icon.svg" alt="Clowe" width={size} height={size} className={`block select-none ${className}`} draggable={false} />
  );
}
