import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { IMAGE_WIDTHS } from '@clowe/shared';

// ---------------------------------------------------------------------------
// Public uploads are stored as WebP copies at a few widths, so a 5 MB photo
// never goes to a phone: <base>-w320.webp, -w800, -w1600, -w2000. Widths above
// the original's are not made, except the first one above it, which holds the
// image at its own size, so the largest copy is always full resolution. The
// URL handed back names the largest; the storefront picks a smaller copy
// from it (shared imageAt / imageSrcSet).
// ---------------------------------------------------------------------------

const QUALITY = 82;

/**
 * The nominal widths to store for an image this wide: every width up to it,
 * and the next one above when it falls between two (that copy holds the
 * image at its own size). 1200 px → 320, 800, 1600 (at 1200); 3000 → all four.
 */
export function widthsFor(originalWidth: number): number[] {
  const widths: number[] = IMAGE_WIDTHS.filter((w) => w <= originalWidth);
  const above = IMAGE_WIDTHS.find((w) => w > originalWidth);
  if (above !== undefined && widths.at(-1) !== originalWidth) widths.push(above);
  return widths;
}

/**
 * Store `source` (a file in `dir`) as its WebP copies, delete the original,
 * and return the file name of the largest copy. EXIF orientation is applied
 * and all metadata dropped (no GPS or camera serial leaves with a photo).
 */
export async function storeImageVariants(source: string, dir: string, base: string): Promise<string> {
  const meta = await sharp(source, { failOn: 'none' }).metadata();
  // After rotate(), a portrait phone photo's width is its short side.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? IMAGE_WIDTHS[0];
  const widths = widthsFor(width);
  for (const w of widths) {
    await sharp(source, { failOn: 'none' })
      .rotate()
      .resize({ width: Math.min(w, width), withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(path.join(dir, `${base}-w${w}.webp`));
  }
  await fs.unlink(source).catch(() => {});
  return `${base}-w${widths.at(-1)}.webp`;
}
