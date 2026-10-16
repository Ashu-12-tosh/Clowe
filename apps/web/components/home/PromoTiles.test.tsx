import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PromoTileView } from '@clowe/shared';
import { PromoCard } from './PromoTiles';

const card = (over: Partial<PromoTileView> = {}): PromoTileView => ({
  id: 'p1',
  title: 'Shop Home & Kitchen',
  subtitle: 'Cookware, decor, bedding and more',
  imageUrl: 'https://cloweshop.com/uploads/promo-home-w800.webp',
  href: '/products?category=home-kitchen',
  imageMode: 'DESIGNED',
  altText: null,
  mobileImageUrl: null,
  focalX: 50,
  focalY: 50,
  ...over,
});

describe('promo card', () => {
  it('with a picture: shows it whole (2:1) above the words, not faded behind them', () => {
    const html = renderToStaticMarkup(<PromoCard card={card()} index={0} icon="🏠" label="Home & Kitchen" />);
    expect(html).toContain('aspect-[2/1]');
    expect(html).not.toContain('opacity-30');
    expect(html).toContain('href="/products?category=home-kitchen"');
  });

  it('labels it with its category and keeps the whole title', () => {
    const html = renderToStaticMarkup(<PromoCard card={card()} index={0} icon="🏠" label="Home & Kitchen" />);
    expect(html).toContain('Home &amp; Kitchen</span>');
    expect(html).toContain('Shop Home &amp; Kitchen</span>');
  });

  it('without a label still splits the title as before (admin preview)', () => {
    const html = renderToStaticMarkup(<PromoCard card={card({ title: 'Fashion New on Clowe', imageUrl: null })} index={0} icon="👗" />);
    expect(html).toContain('>Fashion</p>');
    expect(html).toContain('>New on Clowe</p>');
  });
});
