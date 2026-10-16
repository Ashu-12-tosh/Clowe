// ---------------------------------------------------------------------------
// One icon per subcategory, so a category's tiles tell themselves apart
// instead of all repeating the parent's. Emoji, like the top-level icons, on
// the same cream tile — no icon font to load.
//
// Order of precedence on a tile: an image uploaded in admin (Rules & image),
// then an icon set on the category itself, then this list, then the parent's
// icon. Keyed by slug; a category that is not listed keeps the parent's.
// ---------------------------------------------------------------------------

export const SUBCATEGORY_ICONS: Readonly<Record<string, string>> = {
  // Electronics 🖥️
  'electronics-laptops': '💻',
  'electronics-smartphones': '📲',
  'electronics-tvs': '📺',
  'electronics-headphones': '🎧',
  'electronics-smartwatches': '⏱️',
  'electronics-cameras': '📷',
  'electronics-speakers': '🔊',
  'electronics-accessories': '⌨️',
  'electronics-gaming': '🕹️',
  'electronics-appliances': '🔌',
  'electronics-drones': '🚁',
  'electronics-tablets': '📋',
  // Mobiles 📱
  'mobiles-smartphones': '📲',
  'mobiles-tablets': '📋',
  'mobiles-accessories': '🔋',
  // Fashion 👗
  'fashion-men': '👔',
  'fashion-women': '👚',
  'fashion-kids': '🧒',
  'fashion-ethnic': '🥻',
  'fashion-footwear': '👟',
  'fashion-bags': '👜',
  'fashion-watches': '⌚',
  'fashion-sunglasses': '🕶️',
  'fashion-jewellery': '💍',
  'fashion-caps': '🧢',
  'fashion-innerwear': '🩲',
  'fashion-accessories': '🎀',
  'fashion-winter': '🧥',
  // Home & Kitchen 🏠
  'home-appliances': '☕',
  'home-cookware': '🍳',
  'home-furniture': '🛋️',
  'home-decor': '🖼️',
  'home-bedding': '🛏️',
  // Beauty 💄
  'beauty-skincare': '🧴',
  'beauty-makeup': '💋',
  'beauty-haircare': '💇',
  'beauty-fragrances': '🌸',
  // Books 📚
  'books-fiction': '📖',
  'books-non-fiction': '💡',
  'books-academic': '🎓',
  'books-children': '🐻',
  // Supplements 💪
  'supplements-protein': '🥛',
  'supplements-vitamins': '💊',
  'supplements-fitness': '🥗',
  // Sports ⚽
  'sports-fitness': '🏋️',
  'sports-outdoor': '🏕️',
  'sports-sportswear': '🎽',
  // Gaming 🎮
  'gaming-consoles': '🕹️',
  'gaming-games': '👾',
  'gaming-accessories': '🎧',
  // Grocery 🛒
  'grocery-staples': '🌾',
  'grocery-snacks': '🍿',
  'grocery-packaged': '🥫',
  // Toys & Kids 🧸
  'toys-toys': '🚂',
  'toys-baby-care': '🍼',
  'toys-school': '✏️',
};

/** The icon a category's tile shows when it has no image: its own, this list's, else its parent's. */
export function categoryIcon(category: { slug: string; icon: string | null }, parentIcon?: string | null): string | null {
  return category.icon || SUBCATEGORY_ICONS[category.slug] || parentIcon || null;
}
