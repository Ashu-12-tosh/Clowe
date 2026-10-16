import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CategoryBannerSlide } from '@clowe/shared';
import CategoryHero from './CategoryHero';

const slide = (id: string, headline: string): CategoryBannerSlide => ({
  id,
  eyebrow: null,
  headline,
  highlight: 'Endless Possibilities.',
  subtext: 'Explore electronics from verified sellers, delivered free.',
  imageUrl: 'https://cloweshop.com/uploads/banner-w1600.webp',
  primaryLabel: 'Shop Now',
  primaryHref: '/category/electronics',
  imageMode: 'DESIGNED',
  altText: null,
  mobileImageUrl: null,
  focalX: 50,
  focalY: 50,
});

describe('category banner carousel', () => {
  const html = renderToStaticMarkup(
    <CategoryHero
      slides={[slide('a', 'Latest Tech.'), slide('b', 'Your Home,'), slide('c', 'Work Smarter,')]}
      highlights={[{ icon: '⭐', title: 'Known Brands', subtitle: 'Tech from approved sellers' }]}
    />,
  );

  it('renders every slide in one grid cell, so its height never changes with the slide', () => {
    expect(html.match(/\[grid-area:1\/1\]/g)).toHaveLength(3);
    for (const h of ['Latest Tech.', 'Your Home,', 'Work Smarter,']) expect(html).toContain(h);
    // Only the showing slide is offered to screen readers.
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('clamps the headline and subtext to two lines each', () => {
    expect(html.match(/line-clamp-2/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('puts the highlights under the banner, never over its picture', () => {
    const carouselEnd = html.indexOf('data-category-highlights');
    expect(carouselEnd).toBeGreaterThan(html.lastIndexOf('Go to slide'));
    expect(html).not.toContain('backdrop-blur');
  });
});
