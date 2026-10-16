import { describe, expect, it } from 'vitest';
import { heroPictureShape } from './HeroCarousel';
import { categoryPictureClass } from '../category/CategoryHero';

// On a phone no banner product may be cut off and no headline may sit on one.

describe('home hero picture on a phone', () => {
  it('shows the whole 16:9 picture when there is no phone image', () => {
    expect(heroPictureShape(null)).toBe('aspect-video');
    expect(heroPictureShape(null)).not.toContain('4/5');
  });

  it('uses the phone image’s own 4:5 when there is one', () => {
    expect(heroPictureShape('https://cloweshop.com/uploads/p-w800.webp')).toContain('aspect-[4/5]');
  });
});

describe('category banner picture on a phone', () => {
  it('sits in the flow above the words, whole, and only goes behind them from 640px', () => {
    const cls = categoryPictureClass(null).split(' ');
    expect(cls).toContain('aspect-video');
    expect(cls).not.toContain('absolute');
    expect(cls).toContain('sm:absolute');
  });

  it('uses the phone image’s square when there is one', () => {
    expect(categoryPictureClass('https://cloweshop.com/uploads/p-w800.webp').split(' ')).toContain('aspect-square');
  });
});
