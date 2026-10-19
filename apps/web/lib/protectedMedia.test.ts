import { describe, expect, it } from 'vitest';
import { coverRect } from './protectedMedia';

describe('coverRect (drawing a try-on result on its canvas)', () => {
  it('contain: the whole image, centred, letterboxed', () => {
    expect(coverRect(600, 800, 400, 400, 'contain')).toEqual({ x: 50, y: 0, width: 300, height: 400 });
  });
  it('cover: fills the box, centred, the overflow cropped', () => {
    const r = coverRect(600, 800, 400, 400, 'cover');
    expect(r.x).toBe(0);
    expect(r.width).toBe(400);
    expect(r.height).toBeCloseTo(533.333, 2);
    expect(r.y).toBeCloseTo(-66.667, 2);
  });
  it('draws nothing for an empty image or box', () => {
    expect(coverRect(0, 800, 400, 400, 'contain')).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(coverRect(600, 800, 0, 400, 'cover')).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
