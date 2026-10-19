import sharp from 'sharp';
import type { TryOnImage } from './TryOnProvider';

// ---------------------------------------------------------------------------
// A visible watermark on every generated try-on image (pre-launch audit
// 2026-10-20, D3): who it was made for and when, burned into the pixels, so a
// screenshot or a copy that slips past the page's protections still says
// whose likeness it is. Light — a faint diagonal repeat and one clear corner
// line — so the try-on itself stays easy to judge.
// ---------------------------------------------------------------------------

/** "U-3F9A2C1B": a short reference to the account, never the phone or name. */
export function tryOnUserRef(userId: string): string {
  return `U-${userId.slice(-8).toUpperCase()}`;
}

/** "20 Oct 2026, 14:05 IST" */
export function istStamp(at: Date): string {
  const text = at.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${text} IST`;
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The watermark as an SVG the size of the image. */
export function watermarkSvg(width: number, height: number, label: string): Buffer {
  const text = escapeXml(label);
  const size = Math.max(12, Math.round(Math.min(width, height) / 32));
  const stepX = size * 22;
  const stepY = size * 7;
  const rows: string[] = [];
  // A diagonal field of faint repeats, over the whole image.
  for (let y = -height; y < height * 2; y += stepY) {
    for (let x = -width; x < width * 2; x += stepX) {
      rows.push(`<text x="${x}" y="${y}">${text}</text>`);
    }
  }
  const corner = size * 1.1;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<g transform="rotate(-30 ${width / 2} ${height / 2})" font-family="sans-serif" font-size="${size}" font-weight="600" fill="#ffffff" fill-opacity="0.16" stroke="#000000" stroke-opacity="0.08" stroke-width="0.6">${rows.join('')}</g>` +
      `<rect x="0" y="${height - corner * 2}" width="${width}" height="${corner * 2}" fill="#000000" fill-opacity="0.28"/>` +
      `<text x="${corner * 0.6}" y="${height - corner * 0.65}" font-family="sans-serif" font-size="${corner}" font-weight="700" fill="#ffffff" fill-opacity="0.9">${text}</text>` +
      `</svg>`,
  );
}

/** The image with the watermark burned in, as a JPEG (an SVG preview is rasterised). */
export async function watermarkTryOn(image: TryOnImage, label: string): Promise<{ body: Buffer; contentType: 'image/jpeg' }> {
  const base = sharp(image.body, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' });
  const { data, info } = await base.toBuffer({ resolveWithObject: true });
  const body = await sharp(data)
    .composite([{ input: watermarkSvg(info.width, info.height, label), top: 0, left: 0 }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return { body, contentType: 'image/jpeg' };
}
