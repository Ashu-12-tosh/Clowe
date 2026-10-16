import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The site's icons (made by scripts/make-favicon.mjs from the store logo's
// crown). Next serves app/favicon.ico, app/icon.png and app/apple-icon.png
// and links them from every page; a missing one is a 404 in every console.

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer) {
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('site icons', () => {
  it('favicon.ico holds the 16 and 32 px crown', () => {
    const ico = read('app/favicon.ico');
    expect(ico.readUInt16LE(2)).toBe(1); // an icon, not a cursor
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => {
      const entry = 6 + 16 * i;
      const png = ico.subarray(ico.readUInt32LE(entry + 12), ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8));
      const { width, height } = pngSize(png);
      expect(ico.readUInt8(entry)).toBe(width);
      return `${width}x${height}`;
    });
    expect(sizes).toEqual(['16x16', '32x32']);
  });

  it('icon.png is 32 px, apple-icon and apple-touch-icon 180 px', () => {
    expect(pngSize(read('app/icon.png'))).toEqual({ width: 32, height: 32 });
    expect(pngSize(read('app/apple-icon.png'))).toEqual({ width: 180, height: 180 });
    expect(pngSize(read('public/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });
});
