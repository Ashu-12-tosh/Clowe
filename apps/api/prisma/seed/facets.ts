import type { PrismaClient, Prisma } from '@prisma/client';
import { facetConfigFromJson, resolveFacets, type CategoryFacetConfig, type FacetDef } from '@clowe/shared';

/**
 * The filter facets the catalog starts with, per category slug.
 *
 * Each entry is what that category adds to, hides from and reorders of its
 * parent's set (see packages/shared/src/facets.ts). A slug with no entry
 * inherits its parent's set unchanged. Price, brand, rating, discount and
 * availability are on every rail and are not listed here.
 *
 * Value lists are the values a shopper reads in order, and what a seller picks
 * from in the spec sheet. A list is left off where values are open-ended
 * (fabric, author, capacity), so nothing a seller writes is turned away.
 *
 * Keys are shared where the thing is the same — `veg` in grocery and
 * supplements, `garment_type` across clothing — so a search that spans
 * departments can show one facet for both.
 */

type Def = FacetDef;
const list = (key: string, label: string, values?: string[], alsoKeys?: string[]): Def => ({
  key,
  label,
  kind: 'list',
  ...(values ? { values } : {}),
  ...(alsoKeys ? { alsoKeys } : {}),
});
const size = (key: string, label: string, values?: string[], alsoKeys?: string[]): Def => ({
  ...list(key, label, values, alsoKeys),
  kind: 'size',
});
const COLOR: Def = { key: 'color', label: 'Colour', kind: 'color' };
const config = (c: Partial<CategoryFacetConfig>): CategoryFacetConfig => ({ add: [], hide: [], ...c });

// --- value lists used in more than one place ---------------------------------
const RAM = ['4GB', '6GB', '8GB', '12GB', '16GB', '32GB', '64GB'];
const PHONE_STORAGE = ['64GB', '128GB', '256GB', '512GB', '1TB'];
const NETWORK = ['5G', '4G', 'Wi-Fi only'];
const CONNECTION = ['Wireless', 'Wired', 'Wireless + wired'];
const APPLIANCE_TYPES = [
  'Refrigerator', 'Washing machine', 'Microwave', 'Air conditioner', 'Air purifier', 'Vacuum cleaner',
  'Water purifier', 'Mixer grinder', 'Blender', 'Air fryer', 'Coffee maker', 'Kettle', 'Induction cooktop',
];
const SLEEVE = ['Half sleeve', 'Short sleeve', 'Three-quarter sleeve', 'Full sleeve', 'Sleeveless'];
const FIT = ['Slim', 'Regular', 'Relaxed', 'Oversized'];
const PATTERN = ['Solid', 'Striped', 'Checked', 'Printed', 'Floral', 'Textured', 'Embroidered', 'Woven', 'Zari work'];
const OCCASION = ['Casual', 'Everyday', 'Office', 'Formal', 'Party', 'Festive', 'Wedding', 'Sports', 'Travel', 'Outdoor'];
const AGE_GROUP = ['1–3 years', '3+ years', '5+ years', '6+ years', '8+ years', '12+ years'];
const VEG = ['Veg', 'Non-veg'];
const GAMING_PLATFORM = ['PlayStation 5', 'PlayStation 4', 'Xbox Series X|S', 'Nintendo Switch', 'PC', 'Console'];

export const FACET_SEED: Record<string, CategoryFacetConfig> = {
  // ----------------------------------------------------------------- Electronics
  electronics: config({ add: [COLOR] }),
  'electronics-laptops': config({
    add: [
      list('processor', 'Processor', [
        'Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'Intel Core i9', 'Intel Core Ultra 5', 'Intel Core Ultra 7',
        'AMD Ryzen 5', 'AMD Ryzen 7', 'AMD Ryzen 9', 'Apple M3', 'Snapdragon X Elite',
      ]),
      size('ram', 'RAM', RAM),
      size('storage', 'Storage', ['256GB SSD', '512GB SSD', '1TB SSD', '2TB SSD']),
      size('screen_size', 'Screen size', ['13.3"', '14"', '15.6"', '16"', '17.3"']),
    ],
    order: ['processor', 'ram', 'storage', 'screen_size'],
  }),
  'electronics-smartphones': config({
    add: [
      size('ram', 'RAM', RAM),
      size('storage', 'Storage', PHONE_STORAGE),
      size('screen_size', 'Screen size', ['6.1"', '6.4"', '6.5"', '6.6"', '6.7"', '6.8"']),
      list('network', 'Network', NETWORK),
      list('processor', 'Processor'),
    ],
    order: ['ram', 'storage', 'screen_size', 'network', 'processor'],
  }),
  'electronics-tvs': config({
    add: [
      size('screen_size', 'Screen size', ['32 inch', '43 inch', '50 inch', '55 inch', '65 inch', '75 inch'], ['size', 'screen']),
      list('resolution', 'Resolution', ['HD Ready', 'Full HD', '4K Ultra HD', '8K']),
      list('tv_type', 'Type', ['LED TV', 'QLED TV', 'OLED TV', 'Projector', 'Streaming device']),
    ],
    order: ['screen_size', 'resolution', 'tv_type'],
  }),
  'electronics-headphones': config({
    add: [
      list('headphone_type', 'Type', ['Over-ear', 'On-ear', 'In-ear', 'True wireless', 'Neckband']),
      list('connection', 'Connection', CONNECTION),
      list('noise_cancellation', 'Noise cancellation', ['Active (ANC)', 'Passive', 'None']),
    ],
    order: ['headphone_type', 'connection', 'noise_cancellation'],
  }),
  'electronics-smartwatches': config({
    add: [size('case_size', 'Case size', undefined, ['size']), list('compatible_with', 'Works with', ['Android', 'iPhone', 'Android & iPhone'])],
    order: ['case_size', 'compatible_with'],
  }),
  'electronics-cameras': config({
    add: [list('camera_type', 'Type', ['Mirrorless', 'DSLR', 'Compact', 'Action camera', 'Instant']), list('kit', 'Lens kit')],
    order: ['camera_type', 'kit'],
  }),
  'electronics-speakers': config({
    add: [
      list('speaker_type', 'Type', ['Portable', 'Soundbar', 'Smart speaker', 'Party speaker', 'Home theatre']),
      list('connection', 'Connection', CONNECTION),
    ],
    order: ['speaker_type', 'connection'],
  }),
  'electronics-accessories': config({
    add: [
      list('accessory_type', 'Type', ['Keyboard', 'Mouse', 'Keyboard & mouse', 'Webcam', 'USB hub', 'Monitor', 'Mouse pad', 'Laptop stand']),
      list('connection', 'Connection', CONNECTION),
      list('switch', 'Switch'),
    ],
    order: ['accessory_type', 'connection'],
  }),
  'electronics-gaming': config({
    add: [list('gaming_type', 'Type', ['Console', 'Controller', 'Headset', 'Handheld', 'Accessory']), list('platform', 'Platform', GAMING_PLATFORM)],
    order: ['gaming_type', 'platform'],
  }),
  'electronics-appliances': config({
    add: [
      list('appliance_type', 'Type', APPLIANCE_TYPES),
      list('capacity', 'Capacity'),
      list('energy_rating', 'Energy rating', ['2 Star', '3 Star', '4 Star', '5 Star']),
    ],
    order: ['appliance_type', 'capacity', 'energy_rating'],
  }),
  'electronics-drones': config({
    add: [list('combo', 'Package'), list('flight_time', 'Flight time', ['Under 20 min', '20–30 min', '30 min and above'])],
  }),
  'electronics-tablets': config({
    add: [
      size('storage', 'Storage', PHONE_STORAGE),
      size('screen_size', 'Screen size', ['8"', '10.1"', '10.9"', '11"', '12.4"', '13"']),
      list('network', 'Network', NETWORK),
    ],
    order: ['storage', 'screen_size', 'network'],
  }),

  // ---------------------------------------------------------------------- Mobiles
  mobiles: config({ add: [size('ram', 'RAM', RAM), size('storage', 'Storage', PHONE_STORAGE), COLOR] }),
  'mobiles-smartphones': config({
    add: [
      size('screen_size', 'Screen size', ['6.1"', '6.4"', '6.5"', '6.6"', '6.7"', '6.8"']),
      list('network', 'Network', NETWORK),
      list('processor', 'Processor'),
    ],
  }),
  'mobiles-tablets': config({
    hide: ['ram'],
    add: [size('screen_size', 'Screen size', ['8"', '10.1"', '10.9"', '11"', '12.4"', '13"']), list('network', 'Network', NETWORK)],
  }),
  'mobiles-accessories': config({
    hide: ['ram', 'storage'],
    add: [list('accessory_type', 'Type', ['Case & cover', 'Charger', 'Cable', 'Power bank', 'Screen guard', 'Earphones', 'Holder & stand'])],
    order: ['accessory_type'],
  }),

  // ---------------------------------------------------------------------- Fashion
  fashion: config({
    add: [size('size', 'Size'), COLOR, list('fabric', 'Fabric'), list('pattern', 'Pattern', PATTERN), list('occasion', 'Occasion', OCCASION)],
  }),
  'fashion-men': config({
    add: [
      list('garment_type', 'Type', ['T-shirt', 'Shirt', 'Polo', 'Jeans', 'Trousers', 'Chinos', 'Shorts', 'Joggers', 'Jacket', 'Sweatshirt', 'Kurta']),
      list('fit', 'Fit', FIT),
      list('sleeve', 'Sleeve', SLEEVE),
    ],
    order: ['garment_type', 'size', 'color', 'fit', 'sleeve'],
  }),
  'fashion-women': config({
    add: [
      list('garment_type', 'Type', ['Dress', 'Top', 'T-shirt', 'Shirt', 'Kurti', 'Jeans', 'Trousers', 'Skirt', 'Jumpsuit', 'Co-ord set', 'Jacket']),
      list('fit', 'Fit', FIT),
      list('sleeve', 'Sleeve', SLEEVE),
    ],
    order: ['garment_type', 'size', 'color', 'fit', 'sleeve'],
  }),
  'fashion-kids': config({
    add: [
      list('garment_type', 'Type', ['T-shirt', 'Shirt', 'Dress', 'Frock', 'Shorts', 'Jeans', 'Joggers', 'Clothing set', 'Sweatshirt']),
      list('for_gender', 'For', ['Boys', 'Girls', 'Unisex']),
    ],
    order: ['garment_type', 'for_gender', 'size'],
  }),
  'fashion-ethnic': config({
    add: [
      list('garment_type', 'Type', ['Kurta', 'Kurti', 'Kurta set', 'Saree', 'Lehenga', 'Salwar suit', 'Sherwani', 'Dupatta', 'Nehru jacket']),
      list('sleeve', 'Sleeve', SLEEVE),
    ],
    order: ['garment_type', 'size', 'color'],
  }),
  'fashion-footwear': config({
    hide: ['pattern'],
    add: [
      list('footwear_type', 'Type', ['Sneakers', 'Sports shoes', 'Running shoes', 'Boots', 'Loafers', 'Formal shoes', 'Slip-ons', 'Sandals', 'Flip-flops', 'Heels']),
      list('fabric', 'Material'),
    ],
    order: ['footwear_type', 'size', 'color'],
  }),
  'fashion-bags': config({
    hide: ['size', 'pattern'],
    add: [list('bag_type', 'Type', ['Backpack', 'Handbag', 'Tote', 'Sling bag', 'Wallet', 'Laptop bag', 'Duffel', 'Clutch']), list('fabric', 'Material')],
    order: ['bag_type'],
  }),
  'fashion-watches': config({
    hide: ['size', 'pattern'],
    add: [list('watch_type', 'Type', ['Analog', 'Digital', 'Analog-digital', 'Chronograph', 'Smartwatch']), list('fabric', 'Strap material')],
    order: ['watch_type'],
  }),
  'fashion-sunglasses': config({
    hide: ['size', 'pattern'],
    add: [list('frame_shape', 'Frame shape', ['Aviator', 'Wayfarer', 'Round', 'Rectangle', 'Cat-eye', 'Sport', 'Oversized']), list('fabric', 'Frame material')],
    order: ['frame_shape'],
  }),
  'fashion-jewellery': config({
    hide: ['size', 'pattern'],
    add: [list('jewellery_type', 'Type', ['Earrings', 'Necklace', 'Pendant', 'Bangles', 'Bracelet', 'Ring', 'Jewellery set', 'Anklet']), list('fabric', 'Material')],
    order: ['jewellery_type'],
  }),
  'fashion-caps': config({
    hide: ['size'],
    add: [list('cap_type', 'Type', ['Baseball cap', 'Snapback', 'Trucker cap', 'Bucket hat', 'Beanie', 'Sun hat'])],
    order: ['cap_type'],
  }),
  'fashion-innerwear': config({
    add: [list('garment_type', 'Type', ['Briefs', 'Trunks', 'Boxers', 'Vest', 'Bra', 'Panties', 'Thermal', 'Socks'])],
    order: ['garment_type', 'size'],
  }),
  'fashion-accessories': config({
    hide: ['size', 'pattern'],
    add: [list('accessory_type', 'Type', ['Belt', 'Tie', 'Scarf', 'Socks', 'Gloves', 'Cufflinks', 'Hair accessory', 'Keychain']), list('fabric', 'Material')],
    order: ['accessory_type'],
  }),
  'fashion-winter': config({
    add: [
      list('garment_type', 'Type', ['Jacket', 'Puffer jacket', 'Hoodie', 'Sweatshirt', 'Sweater', 'Coat', 'Thermal', 'Shawl']),
      list('fit', 'Fit', FIT),
    ],
    order: ['garment_type', 'size', 'color'],
  }),

  // ---------------------------------------------------------------- Home & Kitchen
  'home-kitchen': config({ add: [list('material', 'Material'), list('capacity', 'Capacity'), COLOR] }),
  'home-appliances': config({
    add: [list('appliance_type', 'Type', APPLIANCE_TYPES), list('energy_rating', 'Energy rating', ['2 Star', '3 Star', '4 Star', '5 Star'])],
    order: ['appliance_type', 'capacity'],
  }),
  'home-cookware': config({
    add: [
      list('cookware_type', 'Type', ['Kadai', 'Tawa', 'Frying pan', 'Skillet', 'Pressure cooker', 'Saucepan', 'Casserole', 'Cookware set']),
      size('size', 'Size'),
      list('induction', 'Hob', ['Induction & gas', 'Gas only']),
    ],
    order: ['cookware_type', 'material', 'capacity', 'size', 'induction'],
  }),
  'home-furniture': config({
    hide: ['capacity'],
    add: [list('furniture_type', 'Type', ['Chair', 'Table', 'Study table', 'Bookshelf', 'Bed', 'Sofa', 'Storage cabinet', 'Shoe rack'])],
    order: ['furniture_type'],
  }),
  'home-decor': config({
    hide: ['capacity'],
    add: [list('decor_type', 'Type', ['Wall art', 'Vase', 'Table lamp', 'Candle', 'Wall clock', 'Showpiece', 'Photo frame', 'Planter'])],
    order: ['decor_type'],
  }),
  'home-bedding': config({
    hide: ['capacity'],
    add: [
      list('bedding_type', 'Type', ['Bedsheet', 'Comforter', 'Blanket', 'Pillow', 'Mattress protector', 'Bedding set']),
      list('bed_size', 'Bed size', ['Single', 'Double', 'Queen', 'King']),
    ],
    order: ['bedding_type', 'bed_size'],
  }),

  // ----------------------------------------------------------------------- Beauty
  beauty: config({
    add: [
      list('skin_type', 'Skin type', ['All skin types', 'Normal', 'Dry', 'Oily', 'Combination', 'Sensitive']),
      list('formulation', 'Formulation', ['Cream', 'Gel', 'Serum', 'Lotion', 'Liquid', 'Oil', 'Powder', 'Stick', 'Spray']),
      size('volume', 'Size', undefined, ['net_quantity']),
    ],
  }),
  'beauty-skincare': config({
    add: [list('skin_concern', 'Concern', ['Acne', 'Dryness', 'Dullness', 'Ageing', 'Oil control', 'Sun protection', 'Pigmentation'])],
    order: ['skin_type', 'skin_concern'],
  }),
  'beauty-makeup': config({
    add: [list('shade', 'Shade'), list('finish', 'Finish', ['Matte', 'Satin', 'Natural', 'Dewy', 'Glossy'])],
    order: ['shade', 'finish', 'skin_type'],
  }),
  'beauty-haircare': config({
    hide: ['skin_type'],
    add: [list('hair_type', 'Hair type', ['All hair types', 'Dry', 'Oily', 'Curly', 'Frizzy', 'Damaged', 'Colour-treated'])],
    order: ['hair_type'],
  }),
  'beauty-fragrances': config({
    hide: ['skin_type', 'formulation'],
    add: [
      list('fragrance_family', 'Fragrance', ['Floral', 'Woody', 'Fresh', 'Citrus', 'Aquatic', 'Oriental', 'Fruity']),
      list('for_gender', 'For', ['Men', 'Women', 'Unisex']),
    ],
    order: ['fragrance_family', 'for_gender', 'volume'],
  }),

  // ------------------------------------------------------------------------ Books
  books: config({
    add: [
      list('author', 'Author'),
      list('language', 'Language', ['English', 'Hindi', 'Marathi', 'Tamil', 'Telugu', 'Bengali', 'Kannada', 'Malayalam', 'Gujarati']),
      list('format', 'Format', ['Paperback', 'Hardcover', 'Board Book']),
    ],
  }),
  'books-fiction': config({
    add: [list('genre', 'Genre', ['Literary', 'Thriller', 'Mystery', 'Romance', 'Fantasy', 'Science fiction', 'Historical', 'Short stories'])],
    order: ['genre'],
  }),
  'books-non-fiction': config({
    add: [list('subject', 'Subject', ['Biography', 'Business', 'Self-help', 'History', 'Science', 'Politics', 'Travel', 'Health'])],
    order: ['subject'],
  }),
  'books-academic': config({
    add: [list('subject', 'Subject', ['Engineering', 'Medical', 'Commerce', 'Competitive exams', 'School', 'Law', 'Computer science'])],
    order: ['subject'],
  }),
  'books-children': config({ add: [list('age_group', 'Age', AGE_GROUP)], order: ['age_group'] }),

  // ------------------------------------------------------------------ Supplements
  supplements: config({
    add: [
      list('flavour', 'Flavour', ['Chocolate', 'Vanilla', 'Strawberry', 'Mango', 'Coffee', 'Mixed berry', 'Unflavoured']),
      list('veg', 'Diet', VEG),
      size('weight', 'Weight / pack', undefined, ['net_quantity', 'pack']),
    ],
  }),
  'supplements-protein': config({
    add: [list('protein_type', 'Protein', ['Whey concentrate', 'Whey isolate', 'Plant protein', 'Casein', 'Mass gainer'])],
    order: ['protein_type'],
  }),
  'supplements-vitamins': config({
    hide: ['flavour'],
    add: [list('supplement_form', 'Form', ['Tablets', 'Capsules', 'Softgels', 'Gummies', 'Powder', 'Effervescent'])],
    order: ['supplement_form'],
  }),
  'supplements-fitness': config({
    add: [list('supplement_type', 'Type', ['Creatine', 'Pre-workout', 'BCAA', 'EAA', 'Electrolytes', 'Fat burner'])],
    order: ['supplement_type'],
  }),

  // ----------------------------------------------------------------------- Sports
  sports: config({
    add: [
      list('suitable_for', 'Activity', ['Gym', 'Home workouts', 'Running', 'Yoga', 'Cycling', 'Outdoor', 'Cricket', 'Football', 'Badminton', 'Swimming']),
      list('material', 'Material'),
      COLOR,
    ],
  }),
  'sports-fitness': config({
    add: [list('equipment_type', 'Type', ['Dumbbells', 'Kettlebell', 'Yoga mat', 'Resistance bands', 'Skipping rope', 'Bench', 'Ab roller', 'Treadmill'])],
    order: ['equipment_type'],
  }),
  'sports-outdoor': config({
    add: [list('sport', 'Sport', ['Cricket', 'Football', 'Badminton', 'Tennis', 'Basketball', 'Cycling', 'Camping', 'Swimming'])],
    order: ['sport'],
  }),
  'sports-sportswear': config({
    add: [
      list('garment_type', 'Type', ['T-shirt', 'Track pants', 'Shorts', 'Joggers', 'Sports bra', 'Tights', 'Jacket', 'Tracksuit']),
      size('size', 'Size'),
    ],
    order: ['garment_type', 'size'],
  }),

  // ----------------------------------------------------------------------- Gaming
  gaming: config({
    add: [
      list('platform', 'Platform', GAMING_PLATFORM),
      list('genre', 'Genre', ['Action', 'Adventure', 'Sports', 'Racing', 'Role-playing', 'Strategy', 'Shooter', 'Simulation']),
      list('edition', 'Edition'),
      COLOR,
    ],
  }),
  'gaming-consoles': config({ hide: ['genre'] }),
  'gaming-games': config({
    hide: ['color'],
    add: [list('age_rating', 'Age rating', ['3+', '7+', '12+', '16+', '18+'])],
  }),
  'gaming-accessories': config({
    hide: ['genre'],
    add: [list('accessory_type', 'Type', ['Controller', 'Headset', 'Charging station', 'Racing wheel', 'Gaming mouse', 'Gaming keyboard'])],
    order: ['accessory_type', 'platform'],
  }),

  // ---------------------------------------------------------------------- Grocery
  grocery: config({
    add: [size('weight', 'Weight / pack size', undefined, ['net_quantity', 'pack']), list('veg', 'Veg / Non-veg', VEG)],
  }),
  'grocery-staples': config({
    add: [list('staple_type', 'Type', ['Atta & flour', 'Rice', 'Dal & pulses', 'Cooking oil', 'Ghee', 'Sugar & salt', 'Spices'])],
    order: ['staple_type'],
  }),
  'grocery-snacks': config({
    add: [list('snack_type', 'Type', ['Chips & crisps', 'Biscuits & cookies', 'Namkeen', 'Chocolates', 'Dry fruits', 'Tea', 'Coffee', 'Juices & drinks'])],
    order: ['snack_type'],
  }),
  'grocery-packaged': config({
    add: [list('food_type', 'Type', ['Ready to eat', 'Noodles & pasta', 'Breakfast cereal', 'Spreads & jams', 'Sauces & ketchup', 'Pickles', 'Instant mixes'])],
    order: ['food_type'],
  }),

  // ------------------------------------------------------------------ Toys & Kids
  'toys-kids': config({
    add: [
      list('age_group', 'Age', AGE_GROUP),
      list('material', 'Material'),
      COLOR,
      list('battery_required', 'Batteries', ['No', 'Yes - included', 'Yes - not included']),
    ],
  }),
  'toys-toys': config({
    add: [list('toy_type', 'Type', ['Building blocks', 'Soft toys', 'Puzzles', 'Board games', 'Remote control', 'Educational', 'Dolls', 'Action figures'])],
    order: ['toy_type', 'age_group'],
  }),
  'toys-baby-care': config({
    hide: ['battery_required'],
    add: [list('baby_care_type', 'Type', ['Diapers', 'Wipes', 'Bath & skin', 'Feeding', 'Bedding', 'Baby toys'])],
    order: ['baby_care_type', 'age_group'],
  }),
  'toys-school': config({
    hide: ['battery_required'],
    add: [list('school_type', 'Type', ['School bags', 'Stationery', 'Lunch boxes', 'Water bottles', 'Art supplies', 'Pencil boxes'])],
    order: ['school_type'],
  }),
};

export interface FacetSeedReport {
  /** Categories given their seeded facets. */
  written: string[];
  /** Categories that already had facets of their own (an admin's edit, or an earlier seed): left alone. */
  kept: string[];
  /** Categories in the database with no seed entry: they inherit their parent's set. */
  inheriting: string[];
  /** Seed entries for slugs the database does not have. */
  unknownSlugs: string[];
}

/**
 * Give each category its seeded facets — only where it has none of its own,
 * so an admin's edits survive a re-seed. With `apply` false, reports what it
 * would do and writes nothing.
 */
export async function seedCategoryFacets(prisma: PrismaClient, apply: boolean): Promise<FacetSeedReport> {
  const categories = await prisma.category.findMany({ select: { id: true, slug: true, facets: true } });
  const report: FacetSeedReport = { written: [], kept: [], inheriting: [], unknownSlugs: [] };
  const slugs = new Set(categories.map((c) => c.slug));
  report.unknownSlugs = Object.keys(FACET_SEED).filter((slug) => !slugs.has(slug));
  for (const category of categories) {
    const seed = FACET_SEED[category.slug];
    if (!seed) {
      report.inheriting.push(category.slug);
      continue;
    }
    if (facetConfigFromJson(category.facets) !== null) {
      report.kept.push(category.slug);
      continue;
    }
    if (apply) {
      await prisma.category.update({ where: { id: category.id }, data: { facets: seed as Prisma.InputJsonValue } });
    }
    report.written.push(category.slug);
  }
  return report;
}

/** Every category's resolved facets as seeded, for the report: "Laptops: Colour, Processor, …". */
export async function seededFacetTable(prisma: PrismaClient): Promise<{ path: string; slug: string; facets: string[] }[]> {
  const categories = await prisma.category.findMany({
    select: { id: true, slug: true, name: true, parentId: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  const byId = new Map(categories.map((c) => [c.id, c]));
  const chainOf = (id: string) => {
    const out: typeof categories = [];
    for (let c = byId.get(id); c; c = c.parentId ? byId.get(c.parentId) : undefined) out.unshift(c);
    return out;
  };
  const rows: { path: string; slug: string; facets: string[] }[] = [];
  const visit = (parentId: string | null) => {
    for (const c of categories.filter((x) => x.parentId === parentId)) {
      const chain = chainOf(c.id);
      const resolved = resolveFacets(chain.map((n) => ({ id: n.id, config: FACET_SEED[n.slug] ?? null })));
      rows.push({
        path: chain.map((n) => n.name).join(' › '),
        slug: c.slug,
        facets: resolved.map((f) => (f.values ? `${f.label} (${f.values.length} values)` : f.label)),
      });
      visit(c.id);
    }
  };
  visit(null);
  return rows;
}
