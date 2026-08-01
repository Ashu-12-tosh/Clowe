// Marketplace seed data: category tree (2 levels), generic brands, product
// plans, and the admin-managed landing content.
//
// Every brand is fictional — no real trademarks. Product images are stable
// picsum.photos placeholders keyed by slug.

export interface CatDef {
  name: string;
  slug: string;
  icon?: string;
  children?: { name: string; slug: string }[];
}

/**
 * The 11 marketplace roots. Fashion's children are the ORIGINAL clothing
 * categories — listed by their existing slugs so the seed re-parents them
 * (with clearer names) instead of duplicating; products/carts/orders that
 * point at them keep working untouched.
 */
export const CATEGORY_TREE: CatDef[] = [
  {
    name: 'Electronics',
    slug: 'electronics',
    icon: '🖥️',
    children: [
      { name: 'Laptops', slug: 'electronics-laptops' },
      { name: 'TVs', slug: 'electronics-tvs' },
      { name: 'Headphones', slug: 'electronics-headphones' },
      { name: 'Cameras', slug: 'electronics-cameras' },
      { name: 'Speakers', slug: 'electronics-speakers' },
      { name: 'Smartwatches', slug: 'electronics-smartwatches' },
      { name: 'Computer Accessories', slug: 'electronics-accessories' },
    ],
  },
  {
    name: 'Mobiles',
    slug: 'mobiles',
    icon: '📱',
    children: [
      { name: 'Smartphones', slug: 'mobiles-smartphones' },
      { name: 'Tablets', slug: 'mobiles-tablets' },
      { name: 'Mobile Accessories', slug: 'mobiles-accessories' },
    ],
  },
  {
    name: 'Fashion',
    slug: 'fashion',
    icon: '👗',
    children: [
      // Existing clothing categories, re-parented + renamed for the new tree.
      { name: "Men's T-Shirts", slug: 'men-t-shirts' },
      { name: "Men's Shirts", slug: 'men-shirts' },
      { name: "Men's Jeans", slug: 'men-jeans' },
      { name: "Men's Jackets", slug: 'men-jackets' },
      { name: "Women's Dresses", slug: 'women-dresses' },
      { name: "Women's Tops", slug: 'women-tops' },
      { name: 'Kurtis', slug: 'women-kurtis' },
      { name: 'Sarees', slug: 'women-sarees' },
      { name: "Boys' Fashion", slug: 'kids-boys' },
      { name: "Girls' Fashion", slug: 'kids-girls' },
    ],
  },
  {
    name: 'Home & Kitchen',
    slug: 'home-kitchen',
    icon: '🏠',
    children: [
      { name: 'Appliances', slug: 'home-appliances' },
      { name: 'Cookware', slug: 'home-cookware' },
      { name: 'Furniture', slug: 'home-furniture' },
      { name: 'Home Decor', slug: 'home-decor' },
      { name: 'Bedding', slug: 'home-bedding' },
    ],
  },
  {
    name: 'Beauty',
    slug: 'beauty',
    icon: '💄',
    children: [
      { name: 'Skincare', slug: 'beauty-skincare' },
      { name: 'Makeup', slug: 'beauty-makeup' },
      { name: 'Haircare', slug: 'beauty-haircare' },
      { name: 'Fragrances', slug: 'beauty-fragrances' },
    ],
  },
  {
    name: 'Books',
    slug: 'books',
    icon: '📚',
    children: [
      { name: 'Fiction', slug: 'books-fiction' },
      { name: 'Non-Fiction', slug: 'books-non-fiction' },
      { name: 'Academic', slug: 'books-academic' },
      { name: "Children's Books", slug: 'books-children' },
    ],
  },
  {
    name: 'Supplements',
    slug: 'supplements',
    icon: '💪',
    children: [
      { name: 'Protein', slug: 'supplements-protein' },
      { name: 'Vitamins', slug: 'supplements-vitamins' },
      { name: 'Fitness Nutrition', slug: 'supplements-fitness' },
    ],
  },
  {
    name: 'Sports',
    slug: 'sports',
    icon: '⚽',
    children: [
      { name: 'Fitness Equipment', slug: 'sports-fitness' },
      { name: 'Outdoor Sports', slug: 'sports-outdoor' },
      { name: 'Sportswear', slug: 'sports-sportswear' },
    ],
  },
  {
    name: 'Gaming',
    slug: 'gaming',
    icon: '🎮',
    children: [
      { name: 'Consoles', slug: 'gaming-consoles' },
      { name: 'Games', slug: 'gaming-games' },
      { name: 'Gaming Accessories', slug: 'gaming-accessories' },
    ],
  },
  {
    name: 'Grocery',
    slug: 'grocery',
    icon: '🛒',
    children: [
      { name: 'Staples', slug: 'grocery-staples' },
      { name: 'Snacks & Beverages', slug: 'grocery-snacks' },
      { name: 'Packaged Food', slug: 'grocery-packaged' },
    ],
  },
  {
    name: 'Toys & Kids',
    slug: 'toys-kids',
    icon: '🧸',
    children: [
      { name: 'Toys', slug: 'toys-toys' },
      { name: 'Baby Care', slug: 'toys-baby-care' },
      { name: 'School Supplies', slug: 'toys-school' },
    ],
  },
];

/** Original clothing roots that become empty after re-parenting and are removed. */
export const LEGACY_ROOT_SLUGS = ['men', 'women', 'kids'];

// ---------------------------------------------------------------------------
// Brands (all fictional). TrueThread & Fleur already exist as strings on the
// original clothing products — creating Brand rows for them lets the seed
// link that part of the old catalogue too.
// ---------------------------------------------------------------------------

export const BRANDS: { name: string; slug: string }[] = [
  { name: 'NovaTech', slug: 'novatech' },
  { name: 'Zephyr', slug: 'zephyr' },
  { name: 'Aeris', slug: 'aeris' },
  { name: 'Lumen', slug: 'lumen' },
  { name: 'Voltix', slug: 'voltix' },
  { name: 'UrbanFit', slug: 'urbanfit' },
  { name: 'TrueThread', slug: 'truethread' },
  { name: 'Fleur', slug: 'fleur' },
  { name: 'Casa Nova', slug: 'casa-nova' },
  { name: 'Lumière', slug: 'lumiere' },
  { name: 'PureLeaf', slug: 'pureleaf' },
  { name: 'Inkwell Press', slug: 'inkwell-press' },
  { name: 'PlayForge', slug: 'playforge' },
];

// ---------------------------------------------------------------------------
// Product plans
// ---------------------------------------------------------------------------

export interface ProductPlan {
  /** Leaf category slug. */
  cat: string;
  /** Brand name (must exist in BRANDS). */
  brand: string;
  /** One product per model name. */
  models: string[];
  /** Appended to "<brand> <model>". */
  suffix?: string;
  /** Selling price bounds in rupees. */
  price: [number, number];
  /** Discount % bounds (derives MRP). */
  disc: [number, number];
  /**
   * Variant axes. "color" renders as colour; other axes get packed into the
   * display `size` column. Values are cycled/subset per product.
   */
  axes: Record<string, string[]>;
}

export const PRODUCT_PLANS: ProductPlan[] = [
  // Electronics — 18
  {
    cat: 'electronics-laptops',
    brand: 'NovaTech',
    models: ['Pulse 14', 'AirBook Slim', 'Raptor 15 Gaming', 'CoreBook Pro'],
    suffix: 'Laptop',
    price: [42990, 129990],
    disc: [10, 25],
    axes: { ram: ['8GB', '16GB'], storage: ['512GB SSD', '1TB SSD'], color: ['Silver', 'Black'] },
  },
  {
    cat: 'electronics-headphones',
    brand: 'Aeris',
    models: ['Wave 700 ANC', 'Studio One', 'AirBuds Pro', 'Bass Core'],
    suffix: 'Headphones',
    price: [1499, 24990],
    disc: [20, 45],
    axes: { color: ['Black', 'White', 'Navy'] },
  },
  {
    cat: 'electronics-tvs',
    brand: 'Lumen',
    models: ['Crystal View 4K', 'Cinema Q QLED', 'Vision Smart'],
    suffix: 'TV',
    price: [15990, 99990],
    disc: [15, 35],
    axes: { screen: ['43 inch', '55 inch', '65 inch'] },
  },
  {
    cat: 'electronics-cameras',
    brand: 'Lumen',
    models: ['Optix R50 Mirrorless', 'Frame 200 DSLR', 'Vista Action Cam'],
    suffix: '',
    price: [8990, 89990],
    disc: [10, 25],
    axes: { color: ['Black'] },
  },
  {
    cat: 'electronics-speakers',
    brand: 'Aeris',
    models: ['Boom 300', 'Cinema Bar 5.1'],
    suffix: 'Speaker',
    price: [1999, 34990],
    disc: [20, 40],
    axes: { color: ['Black', 'Grey'] },
  },
  {
    cat: 'electronics-smartwatches',
    brand: 'NovaTech',
    models: ['Fit 2', 'Vitals Pro'],
    suffix: 'Smartwatch',
    price: [2499, 18990],
    disc: [25, 50],
    axes: { color: ['Black', 'Rose Gold', 'Silver'] },
  },
  {
    cat: 'electronics-accessories',
    brand: 'Voltix',
    models: ['Glide MX Mouse', 'TypePro Mechanical Keyboard'],
    suffix: '',
    price: [699, 8990],
    disc: [20, 45],
    axes: { color: ['Black', 'White'] },
  },
  // Mobiles — 10
  {
    cat: 'mobiles-smartphones',
    brand: 'Zephyr',
    models: ['One 5G', 'Prime X', 'Note Ultra', 'Edge Pro', 'Lite 12', 'Max Neo'],
    suffix: 'Smartphone',
    price: [10999, 79999],
    disc: [10, 30],
    axes: { ram: ['8GB'], storage: ['128GB', '256GB'], color: ['Graphite', 'Blue', 'Silver'] },
  },
  {
    cat: 'mobiles-tablets',
    brand: 'Zephyr',
    models: ['Tab Air', 'Pad Pro 12'],
    suffix: 'Tablet',
    price: [14999, 59999],
    disc: [12, 25],
    axes: { storage: ['128GB', '256GB'], color: ['Grey', 'Silver'] },
  },
  {
    cat: 'mobiles-accessories',
    brand: 'Voltix',
    models: ['Turbo 65W Charger', 'Vault 20000 Power Bank'],
    suffix: '',
    price: [799, 3999],
    disc: [25, 55],
    axes: { color: ['Black', 'White'] },
  },
  // Home & Kitchen — 10
  {
    cat: 'home-appliances',
    brand: 'Casa Nova',
    models: ['AirFry 5L', 'BrewMaster Coffee Maker', 'SwiftMix Blender'],
    suffix: '',
    price: [1999, 12990],
    disc: [20, 45],
    axes: { color: ['Black', 'Steel'] },
  },
  {
    cat: 'home-cookware',
    brand: 'Casa Nova',
    models: ['TriPly Kadai', 'Nonstick 7-Piece Set', 'Cast Iron Skillet'],
    suffix: '',
    price: [899, 7990],
    disc: [25, 50],
    axes: { size: ['24 cm', '28 cm'] },
  },
  {
    cat: 'home-furniture',
    brand: 'Casa Nova',
    models: ['Study Desk', 'Bookshelf 5-Tier'],
    suffix: '',
    price: [3999, 24990],
    disc: [15, 40],
    axes: { color: ['Walnut', 'Oak'] },
  },
  {
    cat: 'home-decor',
    brand: 'Casa Nova',
    models: ['Aroma Candle Trio', 'Wall Frame Set of 6'],
    suffix: '',
    price: [499, 3499],
    disc: [25, 50],
    axes: { color: ['Natural'] },
  },
  // Beauty — 8
  {
    cat: 'beauty-skincare',
    brand: 'Lumière',
    models: ['Vitamin C Serum', 'Hydra Gel Moisturiser', 'SPF 50 Sunscreen'],
    suffix: '',
    price: [349, 1899],
    disc: [15, 40],
    axes: { volume: ['30ml', '50ml'] },
  },
  {
    cat: 'beauty-makeup',
    brand: 'Lumière',
    models: ['Velvet Matte Lipstick', 'Cushion Compact'],
    suffix: '',
    price: [449, 1799],
    disc: [15, 40],
    axes: { shade: ['Ivory', 'Beige', 'Caramel'] },
  },
  {
    cat: 'beauty-haircare',
    brand: 'Lumière',
    models: ['Argan Repair Shampoo', 'Silk Smooth Conditioner'],
    suffix: '',
    price: [299, 1299],
    disc: [15, 35],
    axes: { volume: ['200ml', '400ml'] },
  },
  {
    cat: 'beauty-fragrances',
    brand: 'Lumière',
    models: ['Noir Eau de Parfum'],
    suffix: '',
    price: [999, 4999],
    disc: [20, 45],
    axes: { volume: ['50ml', '100ml'] },
  },
  // Books — 8
  {
    cat: 'books-fiction',
    brand: 'Inkwell Press',
    models: ['The Quiet Harbour', 'Salt and Smoke', 'The Cartographer'],
    suffix: '',
    price: [199, 599],
    disc: [15, 40],
    axes: { format: ['Paperback', 'Hardcover'] },
  },
  {
    cat: 'books-non-fiction',
    brand: 'Inkwell Press',
    models: ['Deep Focus', 'The Habit Ledger', 'Money, Simply'],
    suffix: '',
    price: [249, 699],
    disc: [15, 40],
    axes: { format: ['Paperback', 'Hardcover'] },
  },
  {
    cat: 'books-academic',
    brand: 'Inkwell Press',
    models: ['Engineering Mathematics Vol. 1'],
    suffix: '',
    price: [499, 1299],
    disc: [10, 25],
    axes: { format: ['Paperback'] },
  },
  {
    cat: 'books-children',
    brand: 'Inkwell Press',
    models: ['The Sleepy Elephant'],
    suffix: '',
    price: [149, 449],
    disc: [20, 40],
    axes: { format: ['Paperback', 'Board Book'] },
  },
  // Supplements — 6
  {
    cat: 'supplements-protein',
    brand: 'PureLeaf',
    models: ['Whey Protein Isolate', 'Plant Protein'],
    suffix: '',
    price: [1299, 4999],
    disc: [25, 50],
    axes: { flavour: ['Chocolate', 'Vanilla'], weight: ['1kg', '2kg'] },
  },
  {
    cat: 'supplements-vitamins',
    brand: 'PureLeaf',
    models: ['Daily Multivitamin', 'Omega-3 Softgels'],
    suffix: '',
    price: [399, 1499],
    disc: [20, 40],
    axes: { pack: ['60 tabs', '120 tabs'] },
  },
  {
    cat: 'supplements-fitness',
    brand: 'PureLeaf',
    models: ['Creatine Monohydrate', 'Pre-Workout Charge'],
    suffix: '',
    price: [599, 2499],
    disc: [20, 45],
    axes: { flavour: ['Unflavoured', 'Mango'] },
  },
  // Sports — 7
  {
    cat: 'sports-fitness',
    brand: 'UrbanFit',
    models: ['Adjustable Dumbbell Pair', 'Yoga Mat Pro', 'Resistance Band Set'],
    suffix: '',
    price: [499, 9990],
    disc: [20, 45],
    axes: { color: ['Black', 'Blue'] },
  },
  {
    cat: 'sports-outdoor',
    brand: 'UrbanFit',
    models: ['Willow Cricket Bat', 'Match Football'],
    suffix: '',
    price: [699, 6999],
    disc: [20, 40],
    axes: { size: ['Standard'] },
  },
  {
    cat: 'sports-sportswear',
    brand: 'UrbanFit',
    models: ['Dry Active Tee', 'Training Track Jacket'],
    suffix: '',
    price: [599, 2999],
    disc: [30, 55],
    axes: { size: ['S', 'M', 'L', 'XL'], color: ['Black', 'Olive'] },
  },
  // Gaming — 7
  {
    cat: 'gaming-consoles',
    brand: 'PlayForge',
    models: ['Station5 Console', 'Handheld Go'],
    suffix: '',
    price: [19999, 54999],
    disc: [5, 15],
    axes: { color: ['White', 'Black'] },
  },
  {
    cat: 'gaming-games',
    brand: 'PlayForge',
    models: ['Shadow Circuit', 'Rally Legends', 'Kingdom of Ash'],
    suffix: '',
    price: [999, 4499],
    disc: [15, 50],
    axes: { platform: ['Console', 'PC'] },
  },
  {
    cat: 'gaming-accessories',
    brand: 'Voltix',
    models: ['Pro Controller', 'RGB Gaming Headset'],
    suffix: '',
    price: [1499, 9990],
    disc: [20, 45],
    axes: { color: ['Black'] },
  },
  // Grocery — 7
  {
    cat: 'grocery-staples',
    brand: 'PureLeaf',
    models: ['Basmati Rice', 'Cold-Pressed Groundnut Oil', 'Whole Wheat Atta'],
    suffix: '',
    price: [99, 899],
    disc: [8, 25],
    axes: { weight: ['1kg', '5kg'] },
  },
  {
    cat: 'grocery-snacks',
    brand: 'PureLeaf',
    models: ['Roasted Almonds', 'Green Tea 100 Bags'],
    suffix: '',
    price: [149, 999],
    disc: [10, 30],
    axes: { weight: ['250g', '500g'] },
  },
  {
    cat: 'grocery-packaged',
    brand: 'PureLeaf',
    models: ['Peanut Butter Crunchy', 'Instant Oats'],
    suffix: '',
    price: [129, 599],
    disc: [10, 30],
    axes: { weight: ['500g', '1kg'] },
  },
  // Toys & Kids — 6
  {
    cat: 'toys-toys',
    brand: 'PlayForge',
    models: ['Building Blocks 120pc', 'Remote Car Racer', 'Wooden Puzzle Set'],
    suffix: '',
    price: [349, 2999],
    disc: [25, 50],
    axes: { color: ['Multicolour'] },
  },
  {
    cat: 'toys-baby-care',
    brand: 'Fleur',
    models: ['Baby Lotion', 'Feeding Bottle Set'],
    suffix: '',
    price: [199, 1499],
    disc: [20, 40],
    axes: { size: ['Standard'] },
  },
  {
    cat: 'toys-school',
    brand: 'UrbanFit',
    models: ['Backpack 25L'],
    suffix: '',
    price: [699, 1999],
    disc: [25, 50],
    axes: { color: ['Navy', 'Black', 'Pink'] },
  },
];

// ---------------------------------------------------------------------------
// Landing content
// ---------------------------------------------------------------------------

export const HERO_BANNERS = [
  {
    headline: 'Shop Everything. Smarter with AI.',
    highlight: 'AI.',
    subtext:
      'Discover thousands of products with intelligent recommendations and personalised shopping.',
    primaryLabel: 'Shop Now',
    primaryHref: '/products',
    secondaryLabel: 'Explore AI Features',
    secondaryHref: '/tryon',
    image: 'hero-ai-collage',
  },
  {
    headline: 'Fashion, Tried On By You.',
    highlight: 'You.',
    subtext: 'Upload one photo and see any outfit on yourself before you buy.',
    primaryLabel: 'Try It Now',
    primaryHref: '/tryon',
    secondaryLabel: 'Browse Fashion',
    secondaryHref: '/products?category=fashion',
    image: 'hero-fashion',
  },
  {
    headline: 'Upgrade Your Everyday Tech.',
    highlight: 'Tech.',
    subtext: 'Laptops, audio and smart gadgets from brands you can trust.',
    primaryLabel: 'Shop Electronics',
    primaryHref: '/products?category=electronics',
    secondaryLabel: null,
    secondaryHref: null,
    image: 'hero-tech',
  },
];

export const PROMO_CARDS = [
  { title: 'Electronics Mega Sale', subtitle: 'Up to 60% Off', href: '/products?category=electronics', image: 'promo-electronics' },
  { title: 'Fashion New Arrivals', subtitle: 'Min. 40% Off', href: '/products?category=fashion', image: 'promo-fashion' },
  { title: 'Books Festival', subtitle: 'Up to 50% Off', href: '/products?category=books', image: 'promo-books' },
  { title: 'Home & Kitchen Best Deals', subtitle: 'Up to 60% Off', href: '/products?category=home-kitchen', image: 'promo-home' },
];

export const PROMO_STRIPS = [
  { title: 'Genuine Supplements', subtitle: 'Up to 35% Off', href: '/products?category=supplements', image: 'strip-supplements' },
  { title: 'Premium Beauty', subtitle: 'Up to 40% Off', href: '/products?category=beauty', image: 'strip-beauty' },
  { title: 'Grocery Essentials', subtitle: 'Up to 30% Off', href: '/products?category=grocery', image: 'strip-grocery' },
];
