// Fashion catalogue seed: restructures Fashion into the 13 shopping-led
// subcategories the landing page is designed around, moves the original
// clothing catalogue into them, and fills the gaps (footwear, bags, watches,
// sunglasses, jewellery, caps, innerwear, accessories, winter wear).
//
// Idempotent: categories/brands upsert by slug, products skip when their slug
// already exists, and the legacy migration is a no-op once it has run.
import { demoImage } from './demoImage';
import { Prisma, PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { variantOptionFields } from '@clowe/shared';
import { generateReferralCode } from '../../src/utils/crypto';

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

const photo = (keyword: string, lock: number, w = 800, h = 1000) =>
  demoImage(`https://loremflickr.com/${w}/${h}/${keyword}?lock=${lock}`);

// ---------------------------------------------------------------------------
// Subcategories — the order the landing rail shows them in
// ---------------------------------------------------------------------------

interface SubCat {
  name: string;
  slug: string;
  keyword: string;
  /** Legacy fashion subcategories whose products move here. */
  absorbs?: string[];
}

const SUBCATS: SubCat[] = [
  { name: 'Men', slug: 'fashion-men', keyword: 'menswear', absorbs: ['men-t-shirts', 'men-shirts', 'men-jeans'] },
  { name: 'Women', slug: 'fashion-women', keyword: 'womenswear', absorbs: ['women-dresses', 'women-tops'] },
  { name: 'Kids', slug: 'fashion-kids', keyword: 'kids,clothing', absorbs: ['kids-boys', 'kids-girls'] },
  { name: 'Ethnic Wear', slug: 'fashion-ethnic', keyword: 'saree', absorbs: ['women-kurtis', 'women-sarees'] },
  { name: 'Footwear', slug: 'fashion-footwear', keyword: 'sneakers' },
  { name: 'Bags & Wallets', slug: 'fashion-bags', keyword: 'handbag' },
  { name: 'Watches', slug: 'fashion-watches', keyword: 'wristwatch' },
  { name: 'Sunglasses', slug: 'fashion-sunglasses', keyword: 'sunglasses' },
  { name: 'Jewellery', slug: 'fashion-jewellery', keyword: 'jewellery' },
  { name: 'Hats & Caps', slug: 'fashion-caps', keyword: 'cap,hat' },
  { name: 'Innerwear', slug: 'fashion-innerwear', keyword: 'underwear,clothing' },
  { name: 'Accessories', slug: 'fashion-accessories', keyword: 'belt,fashion' },
  { name: 'Winter Wear', slug: 'fashion-winter', keyword: 'jacket,winter', absorbs: ['men-jackets'] },
];

const KEYWORD_BY_CAT = new Map(SUBCATS.map((s) => [s.slug, s.keyword]));

const BRANDS = [
  'UrbanFit',
  'TrueThread',
  'Fleur',
  'Zephyr',
  'Marigold',
  'Stridewear',
  'Nomad & Co',
  'Timeline',
  'Solaris',
  'Aurelia Jewels',
  'Capsule',
  'Everweave',
];

// ---------------------------------------------------------------------------
// Product plans
// ---------------------------------------------------------------------------

interface Plan {
  cat: string;
  brand: string;
  models: string[];
  suffix?: string;
  price: [number, number];
  disc: [number, number];
  axes: Record<string, string[]>;
  /** Key-feature bullets shown on the product page. */
  highlights?: string[];
}

const CLOTHING_SIZES = ['S', 'M', 'L', 'XL'];
const SHOE_SIZES = ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10'];

const PLANS: Plan[] = [
  // ---- Men -----------------------------------------------------------------
  {
    cat: 'fashion-men',
    highlights: ["Soft, breathable fabric", "Regular fit for everyday comfort", "Colourfast — stays fresh wash after wash", "Machine wash cold", "Model is 6'1\" and wears size M"],
    brand: 'UrbanFit',
    models: ['Oversized Graphic Tee', 'Slim Fit Chinos', 'Linen Casual Shirt', 'Cargo Joggers'],
    price: [699, 3499],
    disc: [25, 55],
    axes: { size: CLOTHING_SIZES, color: ['Black', 'Olive', 'Beige'] },
  },
  {
    cat: 'fashion-men',
    highlights: ["Soft, breathable fabric", "Regular fit for everyday comfort", "Colourfast — stays fresh wash after wash", "Machine wash cold", "Model is 6'1\" and wears size M"],
    brand: 'TrueThread',
    models: ['Pique Polo T-Shirt', 'Stretch Denim Jeans', 'Formal Twill Shirt'],
    price: [899, 4299],
    disc: [20, 50],
    axes: { size: CLOTHING_SIZES, color: ['Navy', 'White', 'Charcoal'] },
  },
  // ---- Women ---------------------------------------------------------------
  {
    cat: 'fashion-women',
    highlights: ["Lightweight, flowy fabric", "True-to-size fit", "Skin-friendly and breathable", "Gentle machine wash", "Model is 5'8\" and wears size S"],
    brand: 'Fleur',
    models: ['Floral Wrap Dress', 'Ribbed Bodycon Dress', 'Puff Sleeve Top', 'Pleated Midi Skirt'],
    price: [899, 5499],
    disc: [25, 55],
    axes: { size: CLOTHING_SIZES, color: ['Beige', 'Maroon', 'Powder Blue'] },
  },
  {
    cat: 'fashion-women',
    highlights: ["Lightweight, flowy fabric", "True-to-size fit", "Skin-friendly and breathable", "Gentle machine wash", "Model is 5'8\" and wears size S"],
    brand: 'Marigold',
    models: ['High-Rise Wide Leg Jeans', 'Crop Knit Cardigan', 'Satin Slip Dress'],
    price: [1199, 4999],
    disc: [20, 50],
    axes: { size: CLOTHING_SIZES, color: ['Black', 'Ivory', 'Sage'] },
  },
  // ---- Kids ----------------------------------------------------------------
  {
    cat: 'fashion-kids',
    highlights: ["100% skin-friendly cotton", "Soft seams that don't itch", "Easy-pull elastic waist", "Machine washable", "Colours stay bright after washes"],
    brand: 'Capsule',
    models: ['Kids Cotton Co-ord Set', 'Boys Printed Tee Pack of 3', 'Girls Tiered Frock'],
    price: [499, 2499],
    disc: [30, 60],
    axes: { size: ['2-3Y', '4-5Y', '6-7Y', '8-9Y'], color: ['Multicolour', 'Pink', 'Blue'] },
  },
  // ---- Ethnic Wear ---------------------------------------------------------
  {
    cat: 'fashion-ethnic',
    highlights: ["Traditional weave with a modern drape", "Soft, comfortable lining", "Perfect for festive and wedding wear", "Dry clean recommended", "Blouse/dupatta piece included where shown"],
    brand: 'Marigold',
    models: ['Banarasi Silk Saree', 'Anarkali Kurta Set', 'Chikankari Straight Kurti'],
    price: [1299, 12999],
    disc: [20, 50],
    axes: { size: CLOTHING_SIZES, color: ['Maroon', 'Emerald', 'Mustard'] },
  },
  {
    cat: 'fashion-ethnic',
    highlights: ["Traditional weave with a modern drape", "Soft, comfortable lining", "Perfect for festive and wedding wear", "Dry clean recommended", "Blouse/dupatta piece included where shown"],
    brand: 'Everweave',
    models: ['Men Cotton Kurta Pyjama', 'Nehru Jacket', 'Silk Blend Sherwani'],
    price: [1499, 15999],
    disc: [18, 45],
    axes: { size: CLOTHING_SIZES, color: ['Cream', 'Navy', 'Gold'] },
  },
  // ---- Footwear ------------------------------------------------------------
  {
    cat: 'fashion-footwear',
    highlights: ["Cushioned insole for all-day comfort", "Anti-skid textured outsole", "Breathable upper", "Lightweight construction", "Wipe clean with a damp cloth"],
    brand: 'Stridewear',
    models: ['Air Runner Sports Shoes', 'Classic White Sneakers', 'Trail Running Shoes', 'Canvas Slip-Ons'],
    price: [999, 7999],
    disc: [25, 55],
    axes: { size: SHOE_SIZES, color: ['White', 'Black', 'Grey'] },
  },
  {
    cat: 'fashion-footwear',
    highlights: ["Cushioned insole for all-day comfort", "Anti-skid textured outsole", "Breathable upper", "Lightweight construction", "Wipe clean with a damp cloth"],
    brand: 'Nomad & Co',
    models: ['Leather Derby Formals', 'Suede Chukka Boots', 'Everyday Loafers'],
    price: [1799, 9999],
    disc: [20, 50],
    axes: { size: SHOE_SIZES, color: ['Tan', 'Brown', 'Black'] },
  },
  // ---- Bags & Wallets ------------------------------------------------------
  {
    cat: 'fashion-bags',
    highlights: ["Water-resistant exterior", "Padded laptop sleeve where applicable", "Smooth, long-life zippers", "Multiple organiser pockets", "Reinforced stitching at stress points"],
    brand: 'Nomad & Co',
    models: ['Everyday Laptop Backpack', 'Leather Bifold Wallet', 'Weekender Duffel Bag'],
    price: [599, 6999],
    disc: [25, 55],
    axes: { color: ['Black', 'Tan', 'Navy'] },
  },
  {
    cat: 'fashion-bags',
    highlights: ["Water-resistant exterior", "Padded laptop sleeve where applicable", "Smooth, long-life zippers", "Multiple organiser pockets", "Reinforced stitching at stress points"],
    brand: 'Fleur',
    models: ['Structured Tote Bag', 'Quilted Sling Bag', 'Mini Crossbody'],
    price: [899, 5999],
    disc: [25, 55],
    axes: { color: ['Beige', 'Black', 'Blush'] },
  },
  // ---- Watches -------------------------------------------------------------
  {
    cat: 'fashion-watches',
    highlights: ["Scratch-resistant mineral glass", "3 ATM water resistance", "Durable stainless steel case", "Adjustable strap", "2-year movement warranty"],
    brand: 'Timeline',
    models: ['Analog Steel Watch', 'Minimal Leather Strap Watch', 'Chronograph Sport Watch'],
    price: [999, 12999],
    disc: [25, 60],
    axes: { color: ['Black', 'Silver', 'Rose Gold'] },
  },
  // ---- Sunglasses ----------------------------------------------------------
  {
    cat: 'fashion-sunglasses',
    highlights: ["100% UV400 protection", "Polarised, glare-free lenses", "Lightweight, comfortable frame", "Hard case and cleaning cloth included", "1-year warranty against manufacturing defects"],
    brand: 'Solaris',
    models: ['Wayfarer Sunglasses', 'Aviator Sunglasses', 'Round Retro Sunglasses', 'Sport Wrap Shades'],
    price: [699, 8999],
    disc: [25, 60],
    axes: { color: ['Black', 'Tortoise', 'Gold'] },
  },
  // ---- Jewellery -----------------------------------------------------------
  {
    cat: 'fashion-jewellery',
    highlights: ["Skin-safe, nickel-free finish", "Anti-tarnish coating", "Secure clasp", "Comes in a gift-ready box", "6-month plating warranty"],
    brand: 'Aurelia Jewels',
    models: ['Gold-Plated Pendant Chain', 'Kundan Jhumka Earrings', 'Stackable Ring Set', 'Pearl Choker'],
    price: [399, 9999],
    disc: [30, 65],
    axes: { color: ['Gold', 'Silver', 'Rose Gold'] },
  },
  // ---- Hats & Caps ---------------------------------------------------------
  {
    cat: 'fashion-caps',
    highlights: ["Breathable cotton fabric", "Adjustable strap for a snug fit", "Holds shape after washes", "Curved brim for sun cover", "One size fits most"],
    brand: 'Capsule',
    models: ['Cotton Baseball Cap', 'Bucket Hat', 'Knitted Beanie'],
    price: [299, 1999],
    disc: [30, 60],
    axes: { color: ['Black', 'Beige', 'Navy'] },
  },
  // ---- Innerwear -----------------------------------------------------------
  {
    cat: 'fashion-innerwear',
    highlights: ["Soft combed cotton", "Tag-free for itch-free wear", "Stretch waistband that holds shape", "Breathable and quick-dry", "Machine washable"],
    brand: 'Everweave',
    models: ['Cotton Trunks Pack of 3', 'Seamless Everyday Bra', 'Thermal Base Layer'],
    price: [399, 2499],
    disc: [25, 55],
    axes: { size: CLOTHING_SIZES, color: ['Black', 'White', 'Grey'] },
  },
  // ---- Accessories ---------------------------------------------------------
  {
    cat: 'fashion-accessories',
    highlights: ["Premium finish that lasts", "Everyday-versatile design", "Lightweight and easy to carry", "Easy care — wipe clean"],
    brand: 'Zephyr',
    models: ['Reversible Leather Belt', 'Silk Blend Scarf', 'Wool Blend Socks Pack of 5'],
    price: [299, 2999],
    disc: [25, 60],
    axes: { color: ['Black', 'Brown', 'Multicolour'] },
  },
  // ---- Winter Wear ---------------------------------------------------------
  {
    cat: 'fashion-winter',
    highlights: ["Warm, insulated lining", "Wind-resistant outer shell", "Secure zip pockets", "Ribbed cuffs to lock in warmth", "Machine wash cold"],
    brand: 'Zephyr',
    models: ['Puffer Jacket', 'Hooded Sweatshirt', 'Wool Blend Overcoat', 'Fleece Zip Jacket'],
    price: [1299, 9999],
    disc: [20, 55],
    axes: { size: CLOTHING_SIZES, color: ['Black', 'Olive', 'Navy'] },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function combosOf(axes: Record<string, string[]>, cap = 8): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value })));
  }
  return combos.slice(0, cap);
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

export async function seedFashion(prisma: PrismaClient) {
  const landing = {
    description: 'Your style. Your way. Explore the latest trends in clothing, footwear, accessories and more.',
    tileShape: 'circle',
    highlights: [
      { icon: '⭐', title: 'Top Brands', subtitle: '1000+ Premium Brands' },
      { icon: '✨', title: 'Latest Trends', subtitle: 'Stay Ahead in Style' },
      { icon: '↩', title: 'Easy Returns', subtitle: 'Hassle-free returns' },
    ],
    features: [
      { icon: '✨', title: 'Latest Trends', subtitle: 'New styles added daily' },
      { icon: '⭐', title: 'Top Brands', subtitle: '1000+ premium brands' },
      { icon: '💎', title: 'Premium Quality', subtitle: '100% original products' },
      { icon: '↩', title: 'Easy Returns', subtitle: '7 days return policy' },
      { icon: '🛡', title: 'Secure Payments', subtitle: 'Safe & secure transactions' },
      { icon: '💡', title: 'Fashion Advice', subtitle: 'Style tips & inspiration' },
    ],
  };
  const root = await prisma.category.upsert({
    where: { slug: 'fashion' },
    update: landing,
    create: { name: 'Fashion', slug: 'fashion', icon: '👗', ...landing },
  });

  // -- Hero carousel ---------------------------------------------------------
  const banners = [
    {
      eyebrow: null,
      headline: 'New Styles.',
      highlight: 'New You.',
      subtext: 'Discover the latest fashion trends from top brands.',
      imageUrl: photo('fashion,model', 31, 1200, 600),
      primaryHref: '/category/fashion',
    },
    {
      eyebrow: 'Step out in style',
      headline: 'Footwear from',
      highlight: '₹999.',
      subtext: 'Sneakers, formals and everyday slip-ons.',
      imageUrl: photo('sneakers', 32, 1200, 600),
      primaryHref: '/category/fashion?category=fashion-footwear',
    },
    {
      eyebrow: 'Festive picks',
      headline: 'Ethnic Wear,',
      highlight: 'reimagined.',
      subtext: 'Sarees, kurta sets and sherwanis for every occasion.',
      imageUrl: photo('saree', 33, 1200, 600),
      primaryHref: '/category/fashion?category=fashion-ethnic',
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
        imageUrl: photo(sub.keyword, 200 + i, 400, 400),
      },
      create: {
        name: sub.name,
        slug: sub.slug,
        parentId: root.id,
        sortOrder: i,
        imageUrl: photo(sub.keyword, 200 + i, 400, 400),
      },
    });
    catIdBySlug.set(sub.slug, row.id);
  }

  // -- Fold the original clothing catalogue into the new tiles ---------------
  // Products move; the emptied legacy categories are then removed so the rail
  // shows exactly the 13 designed tiles.
  let moved = 0;
  for (const sub of SUBCATS) {
    for (const legacySlug of sub.absorbs ?? []) {
      const legacy = await prisma.category.findUnique({ where: { slug: legacySlug } });
      if (!legacy) continue;
      const { count } = await prisma.product.updateMany({
        where: { categoryId: legacy.id },
        data: { categoryId: catIdBySlug.get(sub.slug)! },
      });
      moved += count;
      const stillUsed = await prisma.category.findUnique({
        where: { id: legacy.id },
        include: { _count: { select: { products: true, children: true } } },
      });
      if (stillUsed && stillUsed._count.products === 0 && stillUsed._count.children === 0) {
        await prisma.category.delete({ where: { id: legacy.id } });
      }
    }
  }

  // -- Brands ----------------------------------------------------------------
  const brandIdByName = new Map<string, string>();
  for (const [i, name] of BRANDS.entries()) {
    const row = await prisma.brand.upsert({
      where: { slug: slugify(name) },
      update: { name },
      create: { name, slug: slugify(name), sortOrder: 200 + i },
    });
    brandIdByName.set(name, row.id);
  }

  // -- Products --------------------------------------------------------------
  const seller = await ensureDemoSeller(prisma);
  let sku = (await prisma.productVariant.count()) + 40000;
  let created = 0;
  let photoLock = 900;

  for (const [planIndex, plan] of PLANS.entries()) {
    const categoryId = catIdBySlug.get(plan.cat);
    const brandId = brandIdByName.get(plan.brand);
    const keyword = KEYWORD_BY_CAT.get(plan.cat);
    if (!categoryId || !brandId || !keyword) {
      console.warn(`[seed] fashion: unknown cat/brand ${plan.cat} / ${plan.brand}`);
      continue;
    }
    const rng = makeRng(3000 + planIndex * 173);

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
      const ratingCount = Math.floor(60 + rng() * 14000);
      const soldCount = Math.floor(40 + rng() * 20000);
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
            `${title}. Easy 7-day returns, secure payments and free delivery over ₹999. ` +
            `Seeded demo product — imagery is neutral stock photography.`,
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
              return {
                ...variantOptionFields(options),
                sku: `CLW-${String(sku++).padStart(6, '0')}`,
                pricePaise: (price + (vi % 3) * Math.round(price * 0.05)) * 100,
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
    `[seed] Fashion ready: ${SUBCATS.length} subcategories, ${created} new products, ${moved} moved from legacy categories, ${filled} highlight backfills`,
  );
}
