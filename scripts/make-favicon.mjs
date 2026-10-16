// Site icons from the store logo's gold crown (the crown only: no black disc,
// no white rim). Reads the logo, never writes to it.
//   node scripts/make-favicon.mjs <path/to/store-logo.png>
// Writes:
//   apps/web/app/favicon.ico        16 + 32, transparent, thin dark outline
//   apps/web/app/icon.png           32, the same
//   apps/web/app/apple-icon.png     180, the crown on black (iOS fills
//   apps/web/public/apple-touch-icon.png  transparency with black anyway)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const source = process.argv[2];
if (!source) {
  console.error('usage: make-favicon.mjs <store-logo.png>');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps/web');

// 1. The crown as RGBA: gold is bright and saturated; the black disc is dark
//    and the white rim unsaturated, so both fall away.
const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const rgba = Buffer.alloc(W * H * 4);
const clamp = (v) => Math.max(0, Math.min(1, v));
let minX = W, minY = H, maxX = 0, maxY = 0;
for (let i = 0; i < W * H; i++) {
  const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max ? (max - min) / max : 0;
  const a = clamp((max - 40) / 50) * clamp((sat - 0.1) / 0.12);
  rgba.set([r, g, b, Math.round(a * 255)], i * 4);
  if (a > 0.5) {
    const x = i % W, y = Math.floor(i / W);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
}

// 2. Square around the crown, a little margin.
const side = Math.round(Math.max(maxX - minX, maxY - minY) * 1.06);
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
const left = Math.round(cx - side / 2), top = Math.round(cy - side / 2);
const square = Buffer.alloc(side * side * 4); // transparent where the square runs past the logo
for (let y = 0; y < side; y++) {
  for (let x = 0; x < side; x++) {
    const sx = left + x, sy = top + y;
    if (sx >= 0 && sy >= 0 && sx < W && sy < H) rgba.copy(square, (y * side + x) * 4, (sy * W + sx) * 4, (sy * W + sx) * 4 + 4);
  }
}
const crown = await sharp(square, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer();

/** The crown at `size` px, on transparent, with a dark outline so it reads on light and dark tabs. */
async function small(size) {
  const big = size * 16;
  const body = await sharp(crown).resize(big, big).png().toBuffer();
  const alpha = await sharp(body).extractChannel('alpha').blur(big / 22).threshold(8).toBuffer();
  const outline = await sharp({ create: { width: big, height: big, channels: 3, background: '#3b2a05' } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  const outlined = await sharp(outline).composite([{ input: body }]).png().toBuffer();
  return sharp(outlined)
    .resize(size, size, { kernel: 'lanczos3' })
    .modulate({ saturation: 1.15 })
    .sharpen()
    .png()
    .toBuffer();
}

/** The crown centred on black, as a home-screen icon. */
async function touch(size) {
  const inner = Math.round(size * 0.78);
  const body = await sharp(crown).resize(inner, inner).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite([{ input: body, gravity: 'centre' }])
    .png()
    .toBuffer();
}

/** An .ico holding PNG images (every current browser reads these). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size % 256, e);
    header.writeUInt8(size % 256, e + 1);
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((im) => im.png)]);
}

const s16 = await small(16);
const s32 = await small(32);
const t180 = await touch(180);
const out = {
  'app/favicon.ico': ico([{ size: 16, png: s16 }, { size: 32, png: s32 }]),
  'app/icon.png': s32,
  'app/apple-icon.png': t180,
  'public/apple-touch-icon.png': t180,
};
for (const [rel, buf] of Object.entries(out)) {
  fs.writeFileSync(path.join(WEB, rel), buf);
  console.log(`apps/web/${rel}  ${buf.length} bytes`);
}
console.log(`crown box ${maxX - minX}x${maxY - minY} at ${minX},${minY} of ${W}x${H}`);
