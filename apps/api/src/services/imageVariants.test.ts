import { describe, expect, it } from 'vitest';
import { widthsFor } from './imageVariants';

describe('the widths an upload is stored at', () => {
  it('stops at the original, keeping it at full size in the next width up', () => {
    expect(widthsFor(1200)).toEqual([320, 800, 1600]);
    expect(widthsFor(1600)).toEqual([320, 800, 1600]);
    expect(widthsFor(250)).toEqual([320]);
  });
  it('caps a very wide image at 2000', () => {
    expect(widthsFor(4000)).toEqual([320, 800, 1600, 2000]);
    expect(widthsFor(2000)).toEqual([320, 800, 1600, 2000]);
  });
});
