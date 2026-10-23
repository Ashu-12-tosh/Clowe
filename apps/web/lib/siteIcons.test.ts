import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The site's icons (the round Clowe Shop mark, October 2026 logo), all in
// public/ and linked from app/layout.tsx's metadata with their real sizes:
// /favicon.ico (what Google shows beside a result: a multiple of 48 px),
// the SVG mark, the 192 px PNG and the 180 px apple-touch icon. A missing
// one is a 404 in every console. The PWA icons are app/manifest.ts's.

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer) {
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('site icons', () => {
  it('/favicon.ico holds the 16, 32 and 48 px mark', () => {
    const ico = read('public/favicon.ico');
    expect(ico.readUInt16LE(2)).toBe(1); // an icon, not a cursor
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => {
      const entry = 6 + 16 * i;
      const png = ico.subarray(ico.readUInt32LE(entry + 12), ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8));
      const { width, height } = pngSize(png);
      expect(ico.readUInt8(entry)).toBe(width);
      return `${width}x${height}`;
    });
    expect(sizes).toEqual(['16x16', '32x32', '48x48']);
  });

  it('the PNG icons are square at their stated sizes, and the SVG mark is there', () => {
    expect(pngSize(read('public/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
    expect(pngSize(read('public/brand/icon-192.png'))).toEqual({ width: 192, height: 192 });
    expect(pngSize(read('public/brand/icon-512.png'))).toEqual({ width: 512, height: 512 });
    expect(pngSize(read('public/brand/icon-maskable-512.png'))).toEqual({ width: 512, height: 512 });
    expect(read('public/brand/icon.svg').toString('utf8')).toMatch(/^<svg[^>]+viewBox="0 0 1263 1263"/);
  });

  it('no icon is left in app/, where Next would override the declared links', () => {
    for (const f of ['favicon.ico', 'icon.png', 'icon.svg', 'apple-icon.png']) expect(fs.existsSync(path.join(WEB, 'app', f))).toBe(false);
  });
});
