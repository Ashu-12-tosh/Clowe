 
  // Electronics catalogue seed: fills the Electronics landing page with a real
// department — 12 subcategories, their own brands, and ~110 products with
// category-matched photography.
//
// Idempotent: categories/brands upsert by slug, products skip when their slug
// already exists. Brand names are invented (no real trademarks), the same
// convention the rest of the marketplace seed uses.
import { Prisma, PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { generateReferralCode } from '../../src/utils/crypto';

/** Deterministic PRNG (mulberry32) — same seed, same catalogue every run. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Keyword-matched stock photo, stable for a given (keyword, lock) pair — so a
 * headphones product actually shows headphones instead of a random image.
 */
const photo = (keyword: string, lock: number, w = 800, h = 1000) =>
  `https://loremflickr.com/${w}/${h}/${keyword}?lock=${lock}`;

// ---------------------------------------------------------------------------
// Subcategories
// ---------------------------------------------------------------------------

interface SubCat {
  name: string;
  slug: string;
  /** Photo keyword for the tile + product images. */
  keyword: string;
}

const SUBCATS: SubCat[] = [
  { name: 'Laptops', slug: 'electronics-laptops', keyword: 'laptop' },
  { name: 'Smartphones', slug: 'electronics-smartphones', keyword: 'smartphone' },
  { name: 'TV & Home Entertainment', slug: 'electronics-tvs', keyword: 'television' },
  { name: 'Headphones', slug: 'electronics-headphones', keyword: 'headphones' },
  { name: 'Smartwatches', slug: 'electronics-smartwatches', keyword: 'smartwatch' },
  { name: 'Cameras', slug: 'electronics-cameras', keyword: 'camera' },
  { name: 'Audio', slug: 'electronics-speakers', keyword: 'speaker' },
  { name: 'Computer Accessories', slug: 'electronics-accessories', keyword: 'keyboard' },
  { name: 'Gaming', slug: 'electronics-gaming', keyword: 'gamepad' },
  { name: 'Home Appliances', slug: 'electronics-appliances', keyword: 'refrigerator' },
  { name: 'Drones', slug: 'electronics-drones', keyword: 'drone' },
  { name: 'Tablets', slug: 'electronics-tablets', keyword: 'tablet' },
];

const KEYWORD_BY_CAT = new Map(SUBCATS.map((s) => [s.slug, s.keyword]));

const BRANDS = [
  'NovaTech',
  'Aeris',
  'Lumen',
  'Vertex',
  'Zenlite',
  'Orbita',
  'Nexo',
  'Auralis',
  'Soniq',
  'Pulsewear',
  'Optik',
  'Lensa',
  'Keytron',
  'Playr',
  'Frostline',
  'Breezo',
  'Whirlio',
  'Skyra',
];

// ---------------------------------------------------------------------------
// Product plans
// ---------------------------------------------------------------------------

interface Plan {
  cat: string;
  brand: string;
  models: string[];
  suffix?: string;
  /** Selling price bounds, rupees. */
  price: [number, number];
  /** Discount % bounds (derives MRP). */
  disc: [number, number];
  axes: Record<string, string[]>;
  /** Key-feature bullets shown on the product page. */
  highlights?: string[];
}

const PLANS: Plan[] = [
  // ---- Laptops -------------------------------------------------------------
  {
    cat: 'electronics-laptops',
    highlights: ["Latest-gen processor for everyday multitasking", "Full-HD anti-glare display", "Backlit keyboard with precision trackpad", "Up to 10 hours of battery life", "Wi-Fi 6 and Bluetooth 5.2", "1-year onsite brand warranty"],
    brand: 'Vertex',
    models: ['Ultra 13 OLED', 'Studio 16 Creator', 'Flex 14 2-in-1'],
    suffix: 'Laptop',
    price: [54990, 154990],
    disc: [8, 22],
    axes: { ram: ['16GB', '32GB'], storage: ['512GB SSD', '1TB SSD'], color: ['Silver', 'Graphite'] },
  },
  {
    cat: 'electronics-laptops',
    highlights: ["Latest-gen processor for everyday multitasking", "Full-HD anti-glare display", "Backlit keyboard with precision trackpad", "Up to 10 hours of battery life", "Wi-Fi 6 and Bluetooth 5.2", "1-year onsite brand warranty"],
    brand: 'Zenlite',
    models: ['Air 14 Thin & Light', 'Book Go 15', 'Pro X15 Workstation'],
    suffix: 'Laptop',
    price: [32990, 119990],
    disc: [12, 30],
    axes: { ram: ['8GB', '16GB'], storage: ['256GB SSD', '512GB SSD'], color: ['Silver', 'Blue'] },
  },
  // ---- Smartphones ---------------------------------------------------------
  {
    cat: 'electronics-smartphones',
    highlights: ["6.6\" full-HD+ 120Hz display", "50MP main camera with night mode", "5000mAh battery with fast charging", "5G ready across Indian bands", "In-display fingerprint sensor", "1-year brand warranty"],
    brand: 'Orbita',
    models: ['One 5G', 'One Pro 5G', 'Note 12'],
    suffix: 'Smartphone',
    price: [12999, 79999],
    disc: [10, 28],
    axes: { storage: ['128GB', '256GB'], color: ['Midnight', 'Titanium', 'Ocean Blue'] },
  },
  {
    cat: 'electronics-smartphones',
    highlights: ["6.6\" full-HD+ 120Hz display", "50MP main camera with night mode", "5000mAh battery with fast charging", "5G ready across Indian bands", "In-display fingerprint sensor", "1-year brand warranty"],
    brand: 'Vertex',
    models: ['V30 Ultra', 'V30', 'V20 Lite'],
    suffix: 'Smartphone',
    price: [10999, 89999],
    disc: [12, 32],
    axes: { storage: ['128GB', '256GB'], color: ['Black', 'Sage Green'] },
  },
  {
    cat: 'electronics-smartphones',
    highlights: ["6.6\" full-HD+ 120Hz display", "50MP main camera with night mode", "5000mAh battery with fast charging", "5G ready across Indian bands", "In-display fingerprint sensor", "1-year brand warranty"],
    brand: 'Nexo',
    models: ['Prime 5G', 'Prime Max'],
    suffix: 'Smartphone',
    price: [15999, 64999],
    disc: [15, 35],
    axes: { storage: ['128GB', '256GB'], color: ['Silver', 'Purple'] },
  },
  // ---- TV & Home Entertainment --------------------------------------------
  {
    cat: 'electronics-tvs',
    highlights: ["4K Ultra HD resolution", "Built-in smart apps and voice search", "Dolby Audio with 20W speakers", "3 HDMI and 2 USB ports", "Bezel-less design", "1-year comprehensive warranty"],
    brand: 'Auralis',
    models: ['Theatre 55 OLED', 'Frame 43 Smart', 'Cinema 65 Ultra'],
    suffix: 'TV',
    price: [24990, 149990],
    disc: [15, 40],
    axes: { size: ['43 inch', '55 inch', '65 inch'], color: ['Black'] },
  },
  {
    cat: 'electronics-tvs',
    highlights: ["4K Ultra HD resolution", "Built-in smart apps and voice search", "Dolby Audio with 20W speakers", "3 HDMI and 2 USB ports", "Bezel-less design", "1-year comprehensive warranty"],
    brand: 'Lumen',
    models: ['StreamBox 4K', 'Projector Beam 1080p'],
    suffix: '',
    price: [3499, 39990],
    disc: [18, 40],
    axes: { color: ['Black', 'White'] },
  },
  // ---- Headphones ----------------------------------------------------------
  {
    cat: 'electronics-headphones',
    highlights: ["Active noise cancellation", "Up to 40 hours playback", "Bluetooth 5.3 with multipoint pairing", "Built-in mic for clear calls", "Fast charge: 10 min for 5 hours", "Foldable, travel-friendly design"],
    brand: 'Soniq',
    models: ['Quiet 900 ANC', 'Buds Air 3', 'Sport Clip Pro', 'Studio Wired'],
    suffix: 'Headphones',
    price: [999, 29990],
    disc: [22, 50],
    axes: { color: ['Black', 'White', 'Beige'] },
  },
  {
    cat: 'electronics-headphones',
    highlights: ["Active noise cancellation", "Up to 40 hours playback", "Bluetooth 5.3 with multipoint pairing", "Built-in mic for clear calls", "Fast charge: 10 min for 5 hours", "Foldable, travel-friendly design"],
    brand: 'Aeris',
    models: ['Halo Over-Ear', 'Nano Buds'],
    suffix: '',
    price: [1799, 18990],
    disc: [25, 48],
    axes: { color: ['Black', 'Navy'] },
  },
  // ---- Smartwatches --------------------------------------------------------
  {
    cat: 'electronics-smartwatches',
    highlights: ["AMOLED always-on display", "Heart rate and SpO2 tracking", "100+ sport modes", "IP68 water and dust resistance", "7-day battery life", "Bluetooth calling"],
    brand: 'Pulsewear',
    models: ['Active 2', 'Fit Pro AMOLED', 'Luxe Steel'],
    suffix: 'Smartwatch',
    price: [1499, 32990],
    disc: [25, 55],
    axes: { size: ['42mm', '46mm'], color: ['Black', 'Rose Gold', 'Silver'] },
  },
  {
    cat: 'electronics-smartwatches',
    highlights: ["AMOLED always-on display", "Heart rate and SpO2 tracking", "100+ sport modes", "IP68 water and dust resistance", "7-day battery life", "Bluetooth calling"],
    brand: 'Orbita',
    models: ['Watch S1', 'Watch Go'],
    suffix: '',
    price: [2499, 24990],
    disc: [20, 45],
    axes: { size: ['41mm', '45mm'], color: ['Midnight', 'Starlight'] },
  },
  // ---- Cameras -------------------------------------------------------------
  {
    cat: 'electronics-cameras',
    highlights: ["High-resolution sensor for sharp detail", "4K video recording", "Fast hybrid autofocus", "In-body image stabilisation", "Wi-Fi transfer to phone", "1-year brand warranty"],
    brand: 'Optik',
    models: ['Mirrorless M50', 'DSLR D700', 'Action Cam 4K'],
    suffix: '',
    price: [8990, 129990],
    disc: [8, 25],
    axes: { kit: ['Body Only', 'With 18-45mm Lens'], color: ['Black'] },
  },
  {
    cat: 'electronics-cameras',
    highlights: ["High-resolution sensor for sharp detail", "4K video recording", "Fast hybrid autofocus", "In-body image stabilisation", "Wi-Fi transfer to phone", "1-year brand warranty"],
    brand: 'Lensa',
    models: ['Vlog Pro', 'Zoom 300 Superzoom'],
    suffix: 'Camera',
    price: [18990, 74990],
    disc: [10, 28],
    axes: { color: ['Black', 'Silver'] },
  },
  // ---- Audio ---------------------------------------------------------------
  {
    cat: 'electronics-speakers',
    highlights: ["Deep bass with clear highs", "Bluetooth 5.3 wireless range up to 10m", "Up to 12 hours of playtime", "AUX and USB playback", "IPX5 splash resistant", "Compact, portable build"],
    brand: 'Auralis',
    models: ['Boom 300 Party Speaker', 'SoundBar 2.1', 'Home Theatre 5.1'],
    suffix: '',
    price: [2999, 49990],
    disc: [20, 45],
    axes: { color: ['Black', 'Charcoal'] },
  },
  {
    cat: 'electronics-speakers',
    highlights: ["Deep bass with clear highs", "Bluetooth 5.3 wireless range up to 10m", "Up to 12 hours of playtime", "AUX and USB playback", "IPX5 splash resistant", "Compact, portable build"],
    brand: 'Soniq',
    models: ['Mini Bass Bluetooth', 'Tower Pro 120W'],
    suffix: 'Speaker',
    price: [1299, 21990],
    disc: [25, 50],
    axes: { color: ['Black', 'Blue', 'Red'] },
  },
  // ---- Computer Accessories ------------------------------------------------
  {
    cat: 'electronics-accessories',
    highlights: ["Plug-and-play, no drivers needed", "Durable braided cable", "Compatible with Windows, macOS and Linux", "Compact travel-friendly design", "1-year replacement warranty"],
    brand: 'Keytron',
    models: ['Mech K87 RGB Keyboard', 'Silent Slim Keyboard', 'Gaming Headset G5'],
    suffix: '',
    price: [899, 12990],
    disc: [20, 50],
    axes: { switch: ['Red Switch', 'Brown Switch'], color: ['Black', 'White'] },
  },
  {
    cat: 'electronics-accessories',
    highlights: ["Plug-and-play, no drivers needed", "Durable braided cable", "Compatible with Windows, macOS and Linux", "Compact travel-friendly design", "1-year replacement warranty"],
    brand: 'Vertex',
    models: ['Mouse MX Wireless', 'Hub 7-in-1 USB-C', 'Webcam 1080p'],
    suffix: '',
    price: [699, 6990],
    disc: [22, 52],
    axes: { color: ['Black', 'Grey'] },
  },
  {
    cat: 'electronics-accessories',
    highlights: ["Plug-and-play, no drivers needed", "Durable braided cable", "Compatible with Windows, macOS and Linux", "Compact travel-friendly design", "1-year replacement warranty"],
    brand: 'NovaTech',
    models: ['Portable SSD 1TB', 'Laptop Stand Aluminium', 'Power Bank 20000mAh'],
    suffix: '',
    price: [1099, 11990],
    disc: [18, 45],
    axes: { color: ['Silver', 'Black'] },
  },
  // ---- Gaming --------------------------------------------------------------
  {
    cat: 'electronics-gaming',
    highlights: ["Low-latency wireless connection", "Ergonomic grip for long sessions", "Customisable RGB lighting", "Works with PC and console", "1-year brand warranty"],
    brand: 'Playr',
    models: ['Console X Series', 'Controller Pro', 'Racing Wheel GT', 'Handheld Go'],
    suffix: '',
    price: [2499, 54990],
    disc: [10, 30],
    axes: { color: ['Black', 'White'] },
  },
  {
    cat: 'electronics-gaming',
    highlights: ["Low-latency wireless connection", "Ergonomic grip for long sessions", "Customisable RGB lighting", "Works with PC and console", "1-year brand warranty"],
    brand: 'Keytron',
    models: ['RGB Mousepad XL', 'Gaming Chair Recline'],
    suffix: '',
    price: [999, 19990],
    disc: [25, 50],
    axes: { color: ['Black', 'Red'] },
  },
  // ---- Home Appliances -----------------------------------------------------
  {
    cat: 'electronics-appliances',
    highlights: ["Energy-efficient inverter technology", "Low-noise operation", "Rust-resistant build", "Easy-clean removable parts", "1-year product + 5-year compressor warranty"],
    brand: 'Frostline',
    models: ['Frost-Free 260L Refrigerator', 'Side-by-Side 570L Refrigerator'],
    suffix: '',
    price: [22990, 89990],
    disc: [12, 30],
    axes: { color: ['Steel Grey', 'Black Glass'] },
  },
  {
    cat: 'electronics-appliances',
    highlights: ["Energy-efficient inverter technology", "Low-noise operation", "Rust-resistant build", "Easy-clean removable parts", "1-year product + 5-year compressor warranty"],
    brand: 'Breezo',
    models: ['Split AC 1.5 Ton Inverter', 'Air Purifier HEPA', 'Tower Fan Slim'],
    suffix: '',
    price: [3499, 44990],
    disc: [15, 35],
    axes: { color: ['White'] },
  },
  {
    cat: 'electronics-appliances',
    highlights: ["Energy-efficient inverter technology", "Low-noise operation", "Rust-resistant build", "Easy-clean removable parts", "1-year product + 5-year compressor warranty"],
    brand: 'Whirlio',
    models: ['Front Load Washer 7kg', 'Microwave Convection 25L', 'Dishwasher 12 Place'],
    suffix: '',
    price: [7990, 54990],
    disc: [12, 32],
    axes: { color: ['White', 'Silver'] },
  },
  // ---- Drones --------------------------------------------------------------
  {
    cat: 'electronics-drones',
    highlights: ["4K stabilised camera", "Up to 30 minutes flight time", "GPS return-to-home", "Obstacle sensing", "Foldable, carry-anywhere body", "Extra battery in the box"],
    brand: 'Skyra',
    models: ['Mini 3 Drone', 'Pro 4K Camera Drone', 'FPV Racer', 'Nano Beginner Drone'],
    suffix: '',
    price: [3999, 119990],
    disc: [10, 28],
    axes: { combo: ['Standard', 'Fly More Combo'], color: ['Grey'] },
  },
  // ---- Tablets -------------------------------------------------------------
  {
    cat: 'electronics-tablets',
    highlights: ["11\" 2K display", "Quad speakers with Dolby Atmos", "8000mAh long-life battery", "Stylus and keyboard compatible", "Dual-band Wi-Fi", "1-year brand warranty"],
    brand: 'Orbita',
    models: ['Tab S8', 'Tab Lite 10'],
    suffix: '',
    price: [10999, 69999],
    disc: [12, 30],
    axes: { storage: ['64GB', '128GB', '256GB'], color: ['Graphite', 'Silver'] },
  },
  {
    cat: 'electronics-tablets',
    highlights: ["11\" 2K display", "Quad speakers with Dolby Atmos", "8000mAh long-life battery", "Stylus and keyboard compatible", "Dual-band Wi-Fi", "1-year brand warranty"],
    brand: 'Vertex',
    models: ['Pad Pro 11', 'Pad Go 8'],
    suffix: '',
    price: [8999, 59999],
    disc: [15, 35],
    axes: { storage: ['64GB', '128GB'], color: ['Space Grey', 'Blue'] },
  },
];

// ---------------------------------------------------------------------------
// Helpers shared with the marketplace seed
// ---------------------------------------------------------------------------

function combosOf(axes: Record<string, string[]>, cap = 8): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value })));
  }
  return combos.slice(0, cap);
}

/** Non-colour axes are packed into the display `size` column. */
function packAxes(options: Record<string, string>): { size: string; color: string } {
  const color = options.color ?? '';
  const size =
    Object.entries(options)
      .filter(([key]) => key !== 'color')
      .map(([, value]) => value)
      .join(' / ') || 'One Size';
  return { size, color };
}

async function ensureDemoSeller(prisma: PrismaClient) {
  const user = await prisma.user.upsert({
    where: { phone: '9000000001' },
    update: { role: Role.SELLER },
    create: {
      phone: '9000000001',
      name: 'Demo Seller',
      role: Role.SELLER,
      referralCode: generateReferralCode(),
    },
  });
  return prisma.sellerProfile.upsert({
    where: { userId: user.id },
    update: { status: SellerStatus.APPROVED },
    create: {
      userId: user.id,
      shopName: 'Clowe Demo Store',
      description: 'Seeded demo store for development',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      status: SellerStatus.APPROVED,
      approvedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export async function seedElectronics(prisma: PrismaClient) {
  // -- Root category + landing content ---------------------------------------
  const landing = {
    description: 'Upgrade your life with the latest electronics.',
    tileShape: 'square',
    highlights: [
      { icon: '⭐', title: 'Top Brands', subtitle: 'Best of tech, all in one place' },
      { icon: '⚡', title: 'Latest Technology', subtitle: 'Upgrade to the newest innovations' },
      { icon: '🛡', title: 'Secure Payments', subtitle: '100% safe & secure' },
    ],
    features: [
      { icon: '⭐', title: 'Top Brands', subtitle: 'Best of tech, all in one place.' },
      { icon: '⚡', title: 'Latest Technology', subtitle: 'Upgrade to the newest innovations.' },
      { icon: '🏷', title: 'Unbeatable Deals', subtitle: 'Best prices on top products.' },
      { icon: '🛡', title: 'Secure Payments', subtitle: '100% safe & secure.' },
      { icon: '↩', title: 'Easy Returns', subtitle: 'Hassle-free return policy.' },
    ],
  };
  const root = await prisma.category.upsert({
    where: { slug: 'electronics' },
    update: landing,
    create: { name: 'Electronics', slug: 'electronics', icon: '🖥️', ...landing },
  });

  // -- Hero carousel ---------------------------------------------------------
  const banners = [
    {
      eyebrow: 'Future is smarter',
      headline: 'Latest Tech.',
      highlight: 'Endless Possibilities.',
      subtext: 'Explore top brands and best deals on electronics.',
      imageUrl: photo('electronics,gadgets', 21, 1200, 600),
      primaryHref: '/category/electronics',
    },
    {
      eyebrow: 'Big screen season',
      headline: 'Up to 40% off',
      highlight: 'Smart TVs.',
      subtext: 'Cinema at home, from 43" to 65".',
      imageUrl: photo('television', 22, 1200, 600),
      primaryHref: '/category/electronics?category=electronics-tvs',
    },
    {
      eyebrow: 'Work anywhere',
      headline: 'Laptops built',
      highlight: 'for the long haul.',
      subtext: 'Thin, light and all-day battery.',
      imageUrl: photo('laptop', 23, 1200, 600),
      primaryHref: '/category/electronics?category=electronics-laptops',
    },
  ];
  await prisma.categoryBanner.deleteMany({ where: { categoryId: root.id } });
  await prisma.categoryBanner.createMany({
    data: banners.map((b, i) => ({ ...b, categoryId: root.id, sortOrder: i })),
  });

  // -- Subcategories ---------------------------------------------------------
  const catIdBySlug = new Map<string, string>();
  for (const [i, sub] of SUBCATS.entries()) {
    const row = await prisma.category.upsert({
      where: { slug: sub.slug },
      update: {
        name: sub.name,
        parentId: root.id,
        sortOrder: i,
        isActive: true,
        imageUrl: photo(sub.keyword, 100 + i, 400, 400),
      },
      create: {
        name: sub.name,
        slug: sub.slug,
        parentId: root.id,
        sortOrder: i,
        imageUrl: photo(sub.keyword, 100 + i, 400, 400),
      },
    });
    catIdBySlug.set(sub.slug, row.id);
  }

  // -- Brands ----------------------------------------------------------------
  const brandIdByName = new Map<string, string>();
  for (const [i, name] of BRANDS.entries()) {
    const row = await prisma.brand.upsert({
      where: { slug: slugify(name) },
      update: { name },
      create: { name, slug: slugify(name), sortOrder: 100 + i },
    });
    brandIdByName.set(name, row.id);
  }

  // -- Products --------------------------------------------------------------
  const seller = await ensureDemoSeller(prisma);
  let sku = (await prisma.productVariant.count()) + 20000;
  let created = 0;
  let photoLock = 500;

  for (const [planIndex, plan] of PLANS.entries()) {
    const categoryId = catIdBySlug.get(plan.cat);
    const brandId = brandIdByName.get(plan.brand);
    const keyword = KEYWORD_BY_CAT.get(plan.cat);
    if (!categoryId || !brandId || !keyword) {
      console.warn(`[seed] electronics: unknown cat/brand ${plan.cat} / ${plan.brand}`);
      continue;
    }
    const rng = makeRng(9000 + planIndex * 197);

    for (const model of plan.models) {
      const title = `${plan.brand} ${model}${plan.suffix ? ` ${plan.suffix}` : ''}`.trim();
      const slug = slugify(title);
      photoLock += 3;
      if (await prisma.product.findUnique({ where: { slug }, select: { id: true } })) continue;

      const [lo, hi] = plan.price;
      const price = Math.round((lo + rng() * (hi - lo)) / 10) * 10;
      const [dLo, dHi] = plan.disc;
      const discount = Math.round(dLo + rng() * (dHi - dLo));
      const mrp = Math.round(price / (1 - discount / 100) / 10) * 10;

      const ratingAvg = Math.round((3.8 + rng() * 1.1) * 10) / 10;
      const ratingCount = Math.floor(80 + rng() * 12000);
      const soldCount = Math.floor(50 + rng() * 18000);
      const combos = combosOf(plan.axes);

      await prisma.product.create({
        data: {
          sellerId: seller.id,
          categoryId,
          brandId,
          brand: plan.brand,
          title,
          slug,
          description:
            `${title}. Backed by Clowe's 7-day easy returns, secure payments and a ` +
            `1-year brand warranty. Seeded demo product — imagery is neutral stock photography.`,
          highlights: plan.highlights ?? [],
          basePricePaise: price * 100,
          mrpPaise: mrp * 100,
          ratingAvg,
          ratingCount,
          soldCount,
          viewCount: soldCount * 6,
          isBestSeller: rng() > 0.7,
          isNew: rng() > 0.65,
          isTrending: rng() > 0.7,
          status: ProductStatus.APPROVED,
          approvedAt: new Date(),
          images: {
            create: [0, 1, 2].map((i) => ({
              url: photo(keyword, photoLock + i, 800, 1000),
              altText: title,
              sortOrder: i,
            })),
          },
          variants: {
            create: combos.map((options, vi) => {
              const { size, color } = packAxes(options);
              return {
                size,
                color: color || 'Standard',
                optionValues: options,
                sku: `CLW-${String(sku++).padStart(6, '0')}`,
                pricePaise: (price + (vi % 3) * Math.round(price * 0.06)) * 100,
                mrpPaise: mrp * 100,
                stock: Math.floor(4 + rng() * 60),
              };
            }),
          },
        },
      });
      created++;
    }
  }


  // Backfill: products seeded before highlights existed get their category's
  // bullets, so every PDP in this department has a Highlights card.
  const highlightsByCat = new Map<string, string[]>();
  for (const plan of PLANS) {
    if (plan.highlights?.length && !highlightsByCat.has(plan.cat)) {
      highlightsByCat.set(plan.cat, plan.highlights);
    }
  }
  let filled = 0;
  for (const [cat, bullets] of highlightsByCat) {
    const categoryId = catIdBySlug.get(cat);
    if (!categoryId) continue;
    const { count } = await prisma.product.updateMany({
      where: { categoryId, OR: [{ highlights: { equals: Prisma.DbNull } }, { highlights: { equals: [] } }] },
      data: { highlights: bullets },
    });
    filled += count;
  }

  console.log(
    `[seed] Electronics ready: ${SUBCATS.length} subcategories, ${created} new products, ${filled} highlight backfills`,
  );
}
