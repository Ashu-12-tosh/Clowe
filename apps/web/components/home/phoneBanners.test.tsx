import { describe, expect, it } from 'vitest';
import { heroPictureClass } from './HeroCarousel';
import { categoryPictureClass } from '../category/CategoryHero';

// On a phone no banner product may be cut off and no headline may sit on one.

describe('home hero picture', () => {
  const cls = (mobile: string | null) => heroPictureClass(mobile).split(' ');

  it('on a phone: the slide’s 4:5 phone image when there is one', () => {
    expect(cls('https://cloweshop.com/uploads/p-w800.webp')).toContain('aspect-[4/5]');
  });

  it('on a phone without one: the right-hand (product) side of the picture, square', () => {
    expect(cls(null)).toEqual(expect.arrayContaining(['aspect-square', 'object-right']));
    expect(cls(null)).not.toContain('aspect-[4/5]');
  });

  it('on a tablet: the whole 16:9 picture', () => {
    expect(cls(null)).toEqual(expect.arrayContaining(['sm:aspect-video', 'sm:object-center']));
  });

  it('from 1024px: fills the card behind the words, anchored right', () => {
    expect(cls(null)).toEqual(expect.arrayContaining(['lg:h-full', 'lg:aspect-auto', 'lg:object-right', 'object-cover']));
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
