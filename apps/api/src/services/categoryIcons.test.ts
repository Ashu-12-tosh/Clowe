import { describe, expect, it } from 'vitest';
import { SUBCATEGORY_ICONS, categoryIcon } from '@clowe/shared';

// The marketplace's categories as live on production (and in the local seed),
// 16 Oct 2026: each top-level category's icon and its subcategories.
const LIVE_TREE: Record<string, { icon: string; children: string[] }> = {
  electronics: {
    icon: '🖥️',
    children: [
      'electronics-laptops', 'electronics-smartphones', 'electronics-tvs', 'electronics-headphones', 'electronics-smartwatches',
      'electronics-cameras', 'electronics-speakers', 'electronics-accessories', 'electronics-gaming', 'electronics-appliances',
      'electronics-drones', 'electronics-tablets',
    ],
  },
  mobiles: { icon: '📱', children: ['mobiles-smartphones', 'mobiles-tablets', 'mobiles-accessories'] },
  fashion: {
    icon: '👗',
    children: [
      'fashion-men', 'fashion-women', 'fashion-kids', 'fashion-ethnic', 'fashion-footwear', 'fashion-bags', 'fashion-watches',
      'fashion-sunglasses', 'fashion-jewellery', 'fashion-caps', 'fashion-innerwear', 'fashion-accessories', 'fashion-winter',
    ],
  },
  'home-kitchen': { icon: '🏠', children: ['home-appliances', 'home-cookware', 'home-furniture', 'home-decor', 'home-bedding'] },
  beauty: { icon: '💄', children: ['beauty-skincare', 'beauty-makeup', 'beauty-haircare', 'beauty-fragrances'] },
  books: { icon: '📚', children: ['books-fiction', 'books-non-fiction', 'books-academic', 'books-children'] },
  supplements: { icon: '💪', children: ['supplements-protein', 'supplements-vitamins', 'supplements-fitness'] },
  sports: { icon: '⚽', children: ['sports-fitness', 'sports-outdoor', 'sports-sportswear'] },
  gaming: { icon: '🎮', children: ['gaming-consoles', 'gaming-games', 'gaming-accessories'] },
  grocery: { icon: '🛒', children: ['grocery-staples', 'grocery-snacks', 'grocery-packaged'] },
  'toys-kids': { icon: '🧸', children: ['toys-toys', 'toys-baby-care', 'toys-school'] },
};

describe('subcategory icons', () => {
  it('every subcategory has one, distinct within its category and from the category’s own', () => {
    for (const [slug, root] of Object.entries(LIVE_TREE)) {
      const icons = root.children.map((c) => SUBCATEGORY_ICONS[c]);
      expect(icons, slug).not.toContain(undefined);
      expect(new Set(icons).size, `${slug}: ${icons.join(' ')}`).toBe(icons.length);
      expect(icons, slug).not.toContain(root.icon);
    }
  });

  it('lists only subcategories that exist', () => {
    const live = new Set(Object.values(LIVE_TREE).flatMap((r) => r.children));
    expect(Object.keys(SUBCATEGORY_ICONS).filter((s) => !live.has(s))).toEqual([]);
  });

  it('an icon set on the category wins, then the list, then the parent’s', () => {
    expect(categoryIcon({ slug: 'books-fiction', icon: '🐉' }, '📚')).toBe('🐉');
    expect(categoryIcon({ slug: 'books-fiction', icon: null }, '📚')).toBe('📖');
    expect(categoryIcon({ slug: 'books-new-shelf', icon: null }, '📚')).toBe('📚');
    expect(categoryIcon({ slug: 'books-new-shelf', icon: null })).toBeNull();
  });
});
