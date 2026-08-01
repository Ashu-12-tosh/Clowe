// Marketplace seed (Phase 1): category tree, brands, ~90 products across all
// categories, and the admin-managed landing content (banners, promos, deals).
//
// Idempotent: categories/brands upsert by slug, products skip when their slug
// already exists, landing content seeds only into empty tables. The original
// clothing catalogue is preserved — its categories are re-parented under
// Fashion, never recreated.
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { generateReferralCode } from '../../src/utils/crypto';
import {
  BRANDS,
  CATEGORY_TREE,
  HERO_BANNERS,
  LEGACY_ROOT_SLUGS,
  PRODUCT_PLANS,
  PROMO_CARDS,
  PROMO_STRIPS,
} from './marketplaceData';

/** Deterministic PRNG (mulberry32) — the same seed always builds the same catalogue. */
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

/** Stable neutral placeholder images keyed by slug — no brand assets. */
const img = (key: string, w = 800, h = 1000) => `https://picsum.photos/seed/${key}/${w}/${h}`;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

async function seedCategories(prisma: PrismaClient) {
  let sortOrder = 0;
  const idBySlug = new Map<string, string>();

  for (const root of CATEGORY_TREE) {
    const rootRow = await prisma.category.upsert({
      where: { slug: root.slug },
      update: { name: root.name, icon: root.icon ?? null, parentId: null, sortOrder: sortOrder++, isActive: true },
      create: {
        name: root.name,
        slug: root.slug,
        icon: root.icon ?? null,
        imageUrl: img(`cat-${root.slug}`, 400, 400),
        sortOrder: sortOrder++,
      },
    });
    idBySlug.set(root.slug, rootRow.id);

    for (const child of root.children ?? []) {
      const childRow = await prisma.category.upsert({
        where: { slug: child.slug },
        // Existing clothing categories are re-parented + renamed here.
        update: { name: child.name, parentId: rootRow.id, sortOrder: sortOrder++, isActive: true },
        create: {
          name: child.name,
          slug: child.slug,
          parentId: rootRow.id,
          imageUrl: img(`cat-${child.slug}`, 400, 400),
          sortOrder: sortOrder++,
        },
      });
      idBySlug.set(child.slug, childRow.id);
    }
  }

  // The old men/women/kids roots are empty once their children moved to
  // Fashion — remove them only when nothing references them any more.
  for (const slug of LEGACY_ROOT_SLUGS) {
    const legacy = await prisma.category.findUnique({
      where: { slug },
      include: { _count: { select: { products: true, children: true } } },
    });
    if (legacy && legacy._count.products === 0 && legacy._count.children === 0) {
      await prisma.category.delete({ where: { id: legacy.id } });
    }
  }

  console.log(`[seed] Marketplace categories ready: ${idBySlug.size}`);
  return idBySlug;
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

async function seedBrands(prisma: PrismaClient) {
  const idByName = new Map<string, string>();
  for (const [i, brand] of BRANDS.entries()) {
    const row = await prisma.brand.upsert({
      where: { slug: brand.slug },
      update: { name: brand.name, sortOrder: i },
      create: { name: brand.name, slug: brand.slug, sortOrder: i },
    });
    idByName.set(brand.name, row.id);
  }

  // Link pre-existing products whose brand string matches a Brand row.
  for (const [name, id] of idByName) {
    await prisma.product.updateMany({ where: { brand: name, brandId: null }, data: { brandId: id } });
  }

  console.log(`[seed] Brands ready: ${idByName.size}`);
  return idByName;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** Cartesian product of axis values, capped so no product explodes. */
function combosOf(axes: Record<string, string[]>, cap = 8): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value })));
  }
  return combos.slice(0, cap);
}

/** Pack non-color axes into the display `size` column (color stays color). */
function packAxes(options: Record<string, string>): { size: string; color: string } {
  const color = options.color ?? '';
  const size = Object.entries(options)
    .filter(([key]) => key !== 'color')
    .map(([, value]) => value)
    .join(' / ');
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

async function seedProducts(
  prisma: PrismaClient,
  catIdBySlug: Map<string, string>,
  brandIdByName: Map<string, string>,
) {
  const seller = await ensureDemoSeller(prisma);
  const existingVariants = await prisma.productVariant.count();
  let sku = existingVariants + 5000;
  let created = 0;

  for (const [planIndex, plan] of PRODUCT_PLANS.entries()) {
    const categoryId = catIdBySlug.get(plan.cat);
    const brandId = brandIdByName.get(plan.brand);
    if (!categoryId || !brandId) {
      console.warn(`[seed] Skipping plan with unknown cat/brand: ${plan.cat} / ${plan.brand}`);
      continue;
    }
    const rng = makeRng(4000 + planIndex * 131);

    for (const model of plan.models) {
      const title = `${plan.brand} ${model}${plan.suffix ? ` ${plan.suffix}` : ''}`;
      const slug = slugify(title);
      if (await prisma.product.findUnique({ where: { slug }, select: { id: true } })) continue;

      const [lo, hi] = plan.price;
      const price = Math.round((lo + rng() * (hi - lo)) / 10) * 10;
      const [dLo, dHi] = plan.disc;
      const discount = Math.round(dLo + rng() * (dHi - dLo));
      const mrp = Math.round(price / (1 - discount / 100) / 10) * 10;

      const ratingAvg = Math.round((3.7 + rng() * 1.1) * 10) / 10;
      const ratingCount = Math.floor(40 + rng() * 9000);
      const soldCount = Math.floor(30 + rng() * 15000);

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
            `${title}. Quality you can rely on, backed by Clowe's 7-day easy returns ` +
            `and secure payments. Seeded demo product — imagery is neutral placeholder stock.`,
          basePricePaise: price * 100,
          mrpPaise: mrp * 100,
          ratingAvg,
          ratingCount,
          soldCount,
          viewCount: soldCount * 6,
          isBestSeller: rng() > 0.75,
          isNew: rng() > 0.7,
          isTrending: rng() > 0.75,
          status: ProductStatus.APPROVED,
          approvedAt: new Date(),
          images: {
            create: [0, 1, 2].map((i) => ({ url: img(`${slug}-${i}`), altText: title, sortOrder: i })),
          },
          variants: {
            create: combos.map((options, vi) => {
              const { size, color } = packAxes(options);
              return {
                size,
                color,
                optionValues: options,
                sku: `CLW-${String(sku++).padStart(6, '0')}`,
                pricePaise: (price + (vi % 3) * Math.round(price * 0.05)) * 100,
                mrpPaise: mrp * 100,
                stock: Math.floor(5 + rng() * 55),
              };
            }),
          },
        },
      });
      created++;
    }
  }
  console.log(`[seed] Marketplace products created: ${created}`);
}

// ---------------------------------------------------------------------------
// Trending signal: product views over the last 7 days
// ---------------------------------------------------------------------------

async function seedProductViews(prisma: PrismaClient) {
  if ((await prisma.productView.count()) > 0) {
    console.log('[seed] Product views already exist — skipping.');
    return;
  }
  const rng = makeRng(777);
  const products = await prisma.product.findMany({
    where: { status: 'APPROVED' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const now = Date.now();
  const rows: { productId: string; createdAt: Date }[] = [];
  for (const product of products) {
    if (rng() < 0.4) continue; // not every product trends
    const views = Math.floor(3 + rng() * 30);
    for (let i = 0; i < views; i++) {
      rows.push({
        productId: product.id,
        createdAt: new Date(now - Math.floor(rng() * 7 * 24 * 60 * 60 * 1000)),
      });
    }
  }
  await prisma.productView.createMany({ data: rows });
  console.log(`[seed] Product views seeded: ${rows.length}`);
}

// ---------------------------------------------------------------------------
// Landing content
// ---------------------------------------------------------------------------

async function seedLandingContent(prisma: PrismaClient) {
  if ((await prisma.homeBanner.count()) === 0) {
    for (const [i, banner] of HERO_BANNERS.entries()) {
      await prisma.homeBanner.create({
        data: {
          headline: banner.headline,
          highlight: banner.highlight,
          subtext: banner.subtext,
          imageUrl: img(banner.image, 1000, 750),
          primaryLabel: banner.primaryLabel,
          primaryHref: banner.primaryHref,
          secondaryLabel: banner.secondaryLabel,
          secondaryHref: banner.secondaryHref,
          sortOrder: i,
        },
      });
    }
    console.log(`[seed] Hero banners seeded: ${HERO_BANNERS.length}`);
  }

  if ((await prisma.promoTile.count()) === 0) {
    for (const [i, tile] of PROMO_CARDS.entries()) {
      await prisma.promoTile.create({
        data: {
          placement: 'PROMO_CARD',
          title: tile.title,
          subtitle: tile.subtitle,
          imageUrl: img(tile.image, 600, 400),
          href: tile.href,
          sortOrder: i,
        },
      });
    }
    for (const [i, tile] of PROMO_STRIPS.entries()) {
      await prisma.promoTile.create({
        data: {
          placement: 'PROMO_STRIP',
          title: tile.title,
          subtitle: tile.subtitle,
          imageUrl: img(tile.image, 900, 400),
          href: tile.href,
          sortOrder: i,
        },
      });
    }
    console.log(`[seed] Promo tiles seeded: ${PROMO_CARDS.length + PROMO_STRIPS.length}`);
  }

  if ((await prisma.deal.count()) === 0) {
    // Best-discounted products headline the deal.
    const discounted = await prisma.product.findMany({
      where: { status: 'APPROVED', mrpPaise: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { id: true, basePricePaise: true, mrpPaise: true },
    });
    const ranked = discounted
      .map((p) => ({ id: p.id, off: (p.mrpPaise! - p.basePricePaise) / p.mrpPaise! }))
      .sort((a, b) => b.off - a.off);

    const now = Date.now();
    await prisma.deal.create({
      data: {
        title: 'Deals of the Day',
        startAt: new Date(now - 60 * 60 * 1000),
        endAt: new Date(now + 48 * 60 * 60 * 1000),
        items: { create: ranked.slice(0, 8).map((p, i) => ({ productId: p.id, sortOrder: i })) },
      },
    });
    // A second, scheduled window demonstrates the automatic takeover.
    await prisma.deal.create({
      data: {
        title: 'Weekend Deals',
        startAt: new Date(now + 48 * 60 * 60 * 1000),
        endAt: new Date(now + 96 * 60 * 60 * 1000),
        items: { create: ranked.slice(8, 14).map((p, i) => ({ productId: p.id, sortOrder: i })) },
      },
    });
    console.log('[seed] Deals seeded: 1 live + 1 scheduled');
  }
}

// ---------------------------------------------------------------------------

export async function seedMarketplace(prisma: PrismaClient) {
  const catIdBySlug = await seedCategories(prisma);
  const brandIdByName = await seedBrands(prisma);
  await seedProducts(prisma, catIdBySlug, brandIdByName);
  await seedProductViews(prisma);
  await seedLandingContent(prisma);
}
