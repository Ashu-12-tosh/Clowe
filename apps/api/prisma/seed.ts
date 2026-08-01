// Seed script.
// Phase 1: admin account (ADMIN_PHONE from apps/api/.env).
// Phase 2: demo seller + category tree + dummy clothing catalog.
// Run with: npm run db:seed --workspace=@clowe/api
import 'dotenv/config';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { generateReferralCode } from '../src/utils/crypto';
import { seedMarketplace } from './seed/marketplace';

const prisma = new PrismaClient();

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Dev placeholder images (picsum photos keyed by slug, so they're stable). */
function imageUrls(slug: string, count = 3): string[] {
  return Array.from({ length: count }, (_, i) => `https://picsum.photos/seed/${slug}-${i}/600/800`);
}

async function seedAdmin() {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) {
    console.log('[seed] ADMIN_PHONE not set in .env — skipping admin creation.');
    return;
  }
  const admin = await prisma.user.upsert({
    where: { phone: adminPhone },
    update: { role: Role.ADMIN },
    create: {
      phone: adminPhone,
      name: 'Clowe Admin',
      role: Role.ADMIN,
      referralCode: generateReferralCode(),
    },
  });
  console.log(`[seed] Admin ready: +91 ${admin.phone} (id: ${admin.id})`);
}

async function seedCatalog() {
  if ((await prisma.product.count()) > 0) {
    console.log('[seed] Products already exist — skipping catalog seed.');
    return;
  }

  // --- Demo seller (already APPROVED so their products can go live) ---
  const sellerUser = await prisma.user.upsert({
    where: { phone: '9000000001' },
    update: { role: Role.SELLER },
    create: {
      phone: '9000000001',
      name: 'Demo Seller',
      role: Role.SELLER,
      referralCode: generateReferralCode(),
    },
  });
  const seller = await prisma.sellerProfile.upsert({
    where: { userId: sellerUser.id },
    update: { status: SellerStatus.APPROVED },
    create: {
      userId: sellerUser.id,
      shopName: 'Clowe Demo Store',
      description: 'Seeded demo store for development',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      status: SellerStatus.APPROVED,
      approvedAt: new Date(),
    },
  });
  console.log(`[seed] Demo seller ready: ${seller.shopName} (phone 9000000001)`);

  // --- Category tree ---
  const tree: Record<string, string[]> = {
    Men: ['T-Shirts', 'Shirts', 'Jeans', 'Jackets'],
    Women: ['Dresses', 'Tops', 'Kurtis', 'Sarees'],
    Kids: ['Boys', 'Girls'],
  };
  const categoryBySlug = new Map<string, string>(); // slug → id
  let sortOrder = 0;
  for (const [rootName, children] of Object.entries(tree)) {
    const rootSlug = slugify(rootName);
    const root = await prisma.category.upsert({
      where: { slug: rootSlug },
      update: {},
      create: { name: rootName, slug: rootSlug, sortOrder: sortOrder++ },
    });
    categoryBySlug.set(rootSlug, root.id);
    for (const childName of children) {
      const childSlug = slugify(`${rootName} ${childName}`);
      const child = await prisma.category.upsert({
        where: { slug: childSlug },
        update: {},
        create: { name: childName, slug: childSlug, parentId: root.id, sortOrder: sortOrder++ },
      });
      categoryBySlug.set(childSlug, child.id);
    }
  }
  console.log(`[seed] Categories ready: ${categoryBySlug.size}`);

  // --- Products ---
  // [title, categorySlug, brand, priceRupees, mrpRupees, colors, sizes]
  type Spec = [string, string, string, number, number, string[], string[]];
  const specs: Spec[] = [
    ['Classic Cotton Crew Neck T-Shirt', 'men-t-shirts', 'TrueThread', 499, 799, ['Black', 'White', 'Navy'], ['S', 'M', 'L', 'XL']],
    ['Oversized Graphic Print Tee', 'men-t-shirts', 'UrbanMode', 699, 999, ['Black', 'Olive'], ['M', 'L', 'XL']],
    ['Polo Neck Slim Fit T-Shirt', 'men-t-shirts', 'TrueThread', 899, 1299, ['Navy', 'Maroon', 'White'], ['S', 'M', 'L', 'XL']],
    ['Striped Half Sleeve Tee', 'men-t-shirts', 'CasaWear', 599, 899, ['Blue', 'Grey'], ['S', 'M', 'L']],
    ['Casual Linen Shirt', 'men-shirts', 'CasaWear', 1299, 1999, ['Beige', 'White', 'Sky Blue'], ['M', 'L', 'XL']],
    ['Checked Flannel Shirt', 'men-shirts', 'UrbanMode', 1099, 1699, ['Red', 'Green'], ['S', 'M', 'L', 'XL']],
    ['Formal Oxford Shirt', 'men-shirts', 'TrueThread', 1499, 2299, ['White', 'Light Blue'], ['M', 'L', 'XL']],
    ['Slim Fit Stretch Jeans', 'men-jeans', 'DenimCo', 1799, 2799, ['Dark Blue', 'Black'], ['30', '32', '34', '36']],
    ['Relaxed Fit Baggy Jeans', 'men-jeans', 'DenimCo', 1999, 2999, ['Light Blue'], ['30', '32', '34']],
    ['Distressed Skinny Jeans', 'men-jeans', 'UrbanMode', 1699, 2599, ['Blue', 'Grey'], ['28', '30', '32', '34']],
    ['Bomber Jacket', 'men-jackets', 'UrbanMode', 2499, 3999, ['Black', 'Olive'], ['M', 'L', 'XL']],
    ['Denim Trucker Jacket', 'men-jackets', 'DenimCo', 2299, 3499, ['Blue'], ['S', 'M', 'L', 'XL']],
    ['Floral Print Maxi Dress', 'women-dresses', 'Fleur', 1899, 2999, ['Red', 'Yellow'], ['XS', 'S', 'M', 'L']],
    ['Bodycon Midi Dress', 'women-dresses', 'Fleur', 1599, 2499, ['Black', 'Wine'], ['S', 'M', 'L']],
    ['A-Line Summer Dress', 'women-dresses', 'CasaWear', 1299, 1999, ['White', 'Pink'], ['XS', 'S', 'M', 'L', 'XL']],
    ['Wrap Dress with Belt', 'women-dresses', 'Fleur', 1799, 2799, ['Green', 'Navy'], ['S', 'M', 'L']],
    ['Ruffle Sleeve Top', 'women-tops', 'Fleur', 799, 1299, ['White', 'Peach'], ['XS', 'S', 'M', 'L']],
    ['Satin Cami Top', 'women-tops', 'UrbanMode', 699, 1099, ['Black', 'Champagne'], ['S', 'M', 'L']],
    ['Oversized Shirt Top', 'women-tops', 'CasaWear', 999, 1499, ['White', 'Lavender'], ['S', 'M', 'L', 'XL']],
    ['Anarkali Embroidered Kurti', 'women-kurtis', 'Rangreza', 1499, 2499, ['Teal', 'Mustard'], ['S', 'M', 'L', 'XL']],
    ['Straight Cotton Kurti', 'women-kurtis', 'Rangreza', 899, 1399, ['Blue', 'Pink', 'White'], ['S', 'M', 'L', 'XL', 'XXL']],
    ['Banarasi Silk Saree', 'women-sarees', 'Rangreza', 3499, 5999, ['Red', 'Purple'], ['Free Size']],
    ['Boys Cartoon Print T-Shirt', 'kids-boys', 'MiniClub', 399, 699, ['Yellow', 'Blue'], ['4-5Y', '6-7Y', '8-9Y']],
    ['Girls Unicorn Frock', 'kids-girls', 'MiniClub', 799, 1299, ['Pink', 'Purple'], ['4-5Y', '6-7Y', '8-9Y']],
  ];

  let skuCounter = 1;
  for (const [title, categorySlug, brand, price, mrp, colors, sizes] of specs) {
    const categoryId = categoryBySlug.get(categorySlug);
    if (!categoryId) throw new Error(`Unknown category slug in seed: ${categorySlug}`);
    const slug = slugify(`${brand} ${title}`);

    await prisma.product.create({
      data: {
        sellerId: seller.id,
        categoryId,
        title,
        slug,
        brand,
        description:
          `${title} by ${brand}. Premium quality fabric with a comfortable everyday fit. ` +
          `Easy machine wash, colours stay fresh wash after wash. Seeded demo product for development.`,
        basePricePaise: price * 100,
        status: ProductStatus.APPROVED,
        approvedAt: new Date(),
        images: {
          create: imageUrls(slug).map((url, i) => ({ url, altText: title, sortOrder: i })),
        },
        variants: {
          create: colors.flatMap((color) =>
            sizes.map((size) => ({
              size,
              color,
              sku: `CLW-${String(skuCounter++).padStart(5, '0')}`,
              pricePaise: price * 100,
              mrpPaise: mrp * 100,
              stock: 25,
            })),
          ),
        },
      },
    });
  }
  console.log(`[seed] Products created: ${specs.length}`);
}

// Phase 7: demo customers + reviews so the AI review summary has data.
async function seedReviews() {
  if ((await prisma.review.count()) > 0) {
    console.log('[seed] Reviews already exist — skipping review seed.');
    return;
  }

  const reviewers = [
    { phone: '9100000001', name: 'Priya S.' },
    { phone: '9100000002', name: 'Rahul M.' },
    { phone: '9100000003', name: 'Ananya K.' },
    { phone: '9100000004', name: 'Vikram T.' },
    { phone: '9100000005', name: 'Sneha R.' },
  ];
  const users = [];
  for (const r of reviewers) {
    users.push(
      await prisma.user.upsert({
        where: { phone: r.phone },
        update: {},
        create: { phone: r.phone, name: r.name, referralCode: generateReferralCode() },
      }),
    );
  }

  // [rating, comment]
  const templates: [number, string][] = [
    [5, 'Excellent quality! The fabric feels premium and the fit is perfect. Worth every rupee.'],
    [4, 'Really good product. Colour is exactly as shown in pictures. Slightly loose fit for me.'],
    [5, 'Loved it! Ordered a second one in a different colour. Fast delivery too.'],
    [3, 'Decent for the price. Stitching could be better but overall okay.'],
    [4, 'Nice material and comfortable for daily wear. Wash care is easy as mentioned.'],
    [2, 'Size runs small, had to request a return. Quality itself was fine.'],
    [5, 'Perfect fit and great colour. My go-to purchase this season!'],
  ];

  const products = await prisma.product.findMany({
    where: { status: 'APPROVED' },
    orderBy: { createdAt: 'asc' },
    take: 8,
    select: { id: true },
  });

  let created = 0;
  for (const [pIndex, product] of products.entries()) {
    // 3-5 reviews per product, rotating reviewers/templates for variety.
    const count = 3 + (pIndex % 3);
    for (let i = 0; i < count; i++) {
      const user = users[(pIndex + i) % users.length];
      const [rating, comment] = templates[(pIndex * 2 + i) % templates.length];
      await prisma.review.upsert({
        where: { userId_productId: { userId: user.id, productId: product.id } },
        update: {},
        create: { userId: user.id, productId: product.id, rating, comment },
      });
      created++;
    }
  }
  console.log(`[seed] Reviews created: ${created} across ${products.length} products`);
}

async function main() {
  await seedAdmin();
  await seedCatalog();
  await seedReviews();
  await seedMarketplace(prisma);
  await syncRatingCache();
}

/**
 * Recompute the denormalised rating columns from real reviews, so products
 * that have actual reviews never disagree with the cache. (Marketplace-seeded
 * products keep their synthetic ratings — they have no review rows.)
 */
async function syncRatingCache() {
  const grouped = await prisma.review.groupBy({
    by: ['productId'],
    _avg: { rating: true },
    _count: { rating: true },
  });
  for (const row of grouped) {
    await prisma.product.update({
      where: { id: row.productId },
      data: {
        ratingAvg: Math.round((row._avg.rating ?? 0) * 10) / 10,
        ratingCount: row._count.rating,
      },
    });
  }
  console.log(`[seed] Rating cache synced for ${grouped.length} reviewed products`);
}

main()
  .catch((err) => {
    console.error('[seed] Failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
