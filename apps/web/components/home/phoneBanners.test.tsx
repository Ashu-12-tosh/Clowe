import { describe, expect, it } from 'vitest';
import { HERO_SLIDE_HEIGHT, heroPictureClass } from './HeroCarousel';
import { categoryPictureClass } from '../category/CategoryHero';

// On a phone no banner product may be cut off and no headline may sit on one.

describe('home hero picture', () => {
  const cls = (mobile: string | null) => heroPictureClass(mobile).split(' ');

  it('on a phone: above the words, capped at 220px, the lower (product) part of the 4:5 phone image', () => {
    expect(cls('https://cloweshop.com/uploads/p-w800.webp')).toEqual(expect.arrayContaining(['h-[220px]', 'w-full', 'object-cover', 'object-[50%_75%]']));
  });

  it('on a phone without one: the right-hand (product) side of the computer picture', () => {
    expect(cls(null)).toEqual(expect.arrayContaining(['h-[220px]', 'object-right']));
  });

  it('from 768px: fills the slide behind the words, anchored right', () => {
    expect(cls(null)).toEqual(expect.arrayContaining(['md:h-full', 'md:object-[100%_60%]', 'object-cover']));
  });

  it('every slide has one fixed height per width: 340, 380 and 440px', () => {
    expect(HERO_SLIDE_HEIGHT.split(' ')).toEqual(['md:h-[340px]', 'lg:h-[380px]', 'xl:h-[440px]']);
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
