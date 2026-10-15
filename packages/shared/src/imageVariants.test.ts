import { describe, expect, it } from 'vitest';
import { imageAt, imageSrcSet, responsiveImage } from './imageVariants';

const UP = 'https://api.example.com/uploads/1700-ab12-w1600.webp';

describe('picking an upload copy for a slot', () => {
  it('takes the smallest stored copy at least that wide', () => {
    expect(imageAt(UP, 300)).toBe('https://api.example.com/uploads/1700-ab12-w320.webp');
    expect(imageAt(UP, 640)).toBe('https://api.example.com/uploads/1700-ab12-w800.webp');
    // Nothing wider was stored: the largest it has.
    expect(imageAt(UP, 1900)).toBe(UP);
  });
  it('lists every stored copy, and none above the largest', () => {
    expect(imageSrcSet(UP)).toBe(
      'https://api.example.com/uploads/1700-ab12-w320.webp 320w, https://api.example.com/uploads/1700-ab12-w800.webp 800w, https://api.example.com/uploads/1700-ab12-w1600.webp 1600w',
    );
  });
  it('leaves any other image as it is', () => {
    for (const url of ['https://cdn.example.com/a-w800.webp', '/uploads/old-photo.jpg', 'https://x.example.com/uploads/old.png']) {
      expect(imageAt(url, 320)).toBe(url);
      expect(imageSrcSet(url)).toBeUndefined();
      expect(responsiveImage(url, '100vw')).toEqual({ src: url });
    }
    expect(imageAt(null, 320)).toBeNull();
  });
  it('gives an <img> a default copy, the srcset and the slot size', () => {
    expect(responsiveImage(UP, '50vw')).toEqual({
      src: 'https://api.example.com/uploads/1700-ab12-w800.webp',
      srcSet: expect.stringContaining('w320.webp 320w'),
      sizes: '50vw',
    });
  });
});
