import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';

/**
 * A deliberately small catalog built for the search tests.
 *
 * Kept separate from prisma/seed/* on purpose: those exist to make the demo
 * storefront look good and are edited for merchandising reasons. If these
 * assertions depended on them, a reworded demo title would break the search
 * regression suite for no reason anybody could see.
 *
 * Every row here exists to pin one behaviour, and says which in a comment.
 * Prices are in PAISE throughout, as everywhere else in the codebase.
 */

export const FIXTURE = {
  /** Under the ₹15,000 cap, inside the category the parser guesses for "phone". */
  phoneCheapInMobiles: 'fx-phone-cheap-mobiles',
  /** Under the cap too, but in the OTHER tree — a hard category filter would hide it. */
  phoneCheapInElectronics: 'fx-phone-cheap-electronics',
  /** Titled "Phone", never "Smartphone": proves alias expansion widens the match. */
  phoneWordedPlainly: 'fx-phone-plain-word',
  /**
   * The best-rated phone, filed in the tree "phone" does NOT infer.
   *
   * Every other phone that wins a sort sits in the Mobiles tree, where the
   * guess already ranks first, so a sort that only broke ties inside the boost
   * would still look right. This one only reaches the top if the sort leads.
   */
  phoneTopRatedInElectronics: 'fx-phone-top-rated-electronics',
  /** Far above the cap, so a "under 500" query has to relax to reach it. */
  phoneExpensive: 'fx-phone-expensive',
  /** High rating off three reviews — must not outrank the well-reviewed one. */
  ratedHighLowCount: 'fx-rated-high-low-count',
  /** Slightly lower rating off thousands of reviews — should win. */
  ratedGoodHighCount: 'fx-rated-good-high-count',
  /** No reviews at all — must rank last, not at the catalog mean. */
  ratedNone: 'fx-rated-none',
  /** Only book, for the explicit ?category= filter. */
  book: 'fx-book',
  /**
   * Titled to sit under the half-typed intent word "best".
   *
   * "be" must keep matching this while "best " becomes a sort — the type-ahead
   * sees a phrase one character at a time, and stripping a partial intent word
   * would silently kill prefix matching for anyone typing towards it.
   */
  partialIntentWord: 'fx-belt',
  /**
   * Contains "phone" inside "Headphones", and costs little enough to pass any
   * price bound a phone query carries.
   *
   * So the only thing that can keep it out of a phone search is the rule that a
   * finished word has to be a word: substring matching would offer it, and the
   * results page's tsquery would not, which is exactly the kind of disagreement
   * between the two endpoints this fixture exists to catch.
   */
  headphoneNotAPhone: 'fx-headphone',
  /** status=DRAFT: must never appear in results or suggestions. */
  hiddenDraft: 'fx-hidden-draft',
  /** isVisible=false: must never appear either. */
  hiddenInvisible: 'fx-hidden-invisible',
} as const;

interface ProductSpec {
  slug: string;
  title: string;
  brand: string;
  categorySlug: string;
  pricePaise: number;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  status?: ProductStatus;
  isVisible?: boolean;
  /** Defaults to a line naming the title; set where the words matter. */
  description?: string;
}

const PRODUCTS: ProductSpec[] = [
  {
    slug: FIXTURE.phoneCheapInMobiles,
    title: 'Zephyr Lite 12 Smartphone',
    brand: 'Zephyr',
    categorySlug: 'mobiles-smartphones',
    pricePaise: 1_200_000, // ₹12,000
    ratingAvg: 4.4,
    ratingCount: 900,
    soldCount: 500,
  },
  {
    slug: FIXTURE.phoneCheapInElectronics,
    title: 'Vertex V30 Smartphone',
    brand: 'Vertex',
    categorySlug: 'electronics-smartphones',
    pricePaise: 1_300_000, // ₹13,000
    ratingAvg: 4.3,
    ratingCount: 800,
    soldCount: 400,
  },
  {
    slug: FIXTURE.phoneWordedPlainly,
    title: 'Nexo Basic Phone',
    brand: 'Nexo',
    categorySlug: 'mobiles-smartphones',
    pricePaise: 300_000, // ₹3,000
    ratingAvg: 4.0,
    ratingCount: 300,
    soldCount: 200,
  },
  {
    slug: FIXTURE.phoneTopRatedInElectronics,
    title: 'Vertex Pro 5G Smartphone',
    brand: 'Vertex',
    categorySlug: 'electronics-smartphones',
    pricePaise: 3_000_000, // ₹30,000 — above every "under 15k" test.
    ratingAvg: 4.7,
    ratingCount: 7_000,
    soldCount: 300,
  },
  {
    slug: FIXTURE.phoneExpensive,
    title: 'Zephyr Max Neo Smartphone',
    brand: 'Zephyr',
    categorySlug: 'mobiles-smartphones',
    pricePaise: 8_000_000, // ₹80,000
    ratingAvg: 4.2,
    ratingCount: 700,
    soldCount: 150,
  },
  {
    slug: FIXTURE.ratedHighLowCount,
    title: 'Zephyr Cotton Crew Tee',
    // A real-world care label. Full-text search reads descriptions, so this tee
    // is a hit for "washing machine" — which is fine on the results page and
    // must never become a suggested search for washing machines.
    description: 'Soft combed cotton. Machine wash cold, tumble dry low.',
    brand: 'Zephyr',
    categorySlug: 'books', // category is irrelevant to the rating assertions
    pricePaise: 200_000,
    ratingAvg: 4.7,
    ratingCount: 3,
    soldCount: 10,
  },
  {
    slug: FIXTURE.ratedGoodHighCount,
    title: 'Zephyr Linen Casual Shirt',
    brand: 'Zephyr',
    categorySlug: 'books',
    pricePaise: 250_000,
    ratingAvg: 4.5,
    ratingCount: 9_000,
    soldCount: 900,
  },
  {
    slug: FIXTURE.ratedNone,
    title: 'Zephyr Unreviewed Jacket',
    brand: 'Zephyr',
    categorySlug: 'books',
    pricePaise: 300_000,
    ratingAvg: 0,
    ratingCount: 0,
    soldCount: 0,
  },
  {
    slug: FIXTURE.book,
    title: 'Inkwell Atlas of Quiet Places',
    brand: 'Inkwell Press',
    categorySlug: 'books',
    pricePaise: 60_000,
    ratingAvg: 4.1,
    ratingCount: 120,
    soldCount: 80,
  },
  {
    slug: FIXTURE.partialIntentWord,
    title: 'Nexo Leather Belt',
    brand: 'Nexo',
    categorySlug: 'electronics',
    // Mentions "book" only in passing. For a search of the Books category that
    // makes it a words-only, description-only match — the noise that has to
    // rank below every product actually filed under Books.
    description: 'Full-grain leather. Rolls up small enough for a book bag.',
    pricePaise: 150_000,
    ratingAvg: 4.2,
    ratingCount: 60,
    soldCount: 90,
  },
  {
    slug: FIXTURE.headphoneNotAPhone,
    title: 'Aeris Studio Headphones',
    brand: 'Nexo',
    categorySlug: 'electronics',
    pricePaise: 500_000, // Well under a "under 15k" cap.
    ratingAvg: 4.3,
    ratingCount: 210,
    soldCount: 150,
  },
  {
    slug: FIXTURE.hiddenDraft,
    title: 'Zephyr Secret Draft Smartphone',
    brand: 'Zephyr',
    categorySlug: 'mobiles-smartphones',
    pricePaise: 500_000,
    ratingAvg: 5,
    ratingCount: 10,
    soldCount: 0,
    status: ProductStatus.DRAFT,
  },
  {
    slug: FIXTURE.hiddenInvisible,
    title: 'Zephyr Hidden Smartphone',
    brand: 'Zephyr',
    categorySlug: 'mobiles-smartphones',
    pricePaise: 500_000,
    ratingAvg: 5,
    ratingCount: 10,
    soldCount: 0,
    isVisible: false,
  },
];

/**
 * Two category trees ending in a leaf with the SAME name.
 *
 * This mirrors the real catalog, where "Smartphones" exists under both
 * Electronics and Mobiles. It is what makes the inferred-category rule
 * testable: a guess of "mobiles" must not hide the electronics one.
 */
const CATEGORIES = [
  { slug: 'electronics', name: 'Electronics', parent: null },
  { slug: 'mobiles', name: 'Mobiles', parent: null },
  { slug: 'books', name: 'Books', parent: null },
  { slug: 'electronics-smartphones', name: 'Smartphones', parent: 'electronics' },
  { slug: 'mobiles-smartphones', name: 'Smartphones', parent: 'mobiles' },
  // Empty on purpose, like Bedding in the live catalog. Searching its name has
  // to return nothing — before, it returned every product with a guess on top.
  { slug: 'bedding', name: 'Bedding', parent: null },
];

/** Brands the parser can match. Deliberately no "Samsung" — typo tests rely on that. */
const BRANDS = ['Zephyr', 'Vertex', 'Nexo', 'Inkwell Press'];

export async function seedFixture(prisma: PrismaClient): Promise<void> {
  // Order matters only for foreign keys; everything else is replaced wholesale.
  await prisma.productVariant.deleteMany();
  await prisma.productImage.deleteMany();
  await prisma.product.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.category.deleteMany();
  await prisma.sellerProfile.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: { phone: '9000000001', name: 'Fixture Seller', role: Role.SELLER, referralCode: 'FX-SELLER' },
  });
  const seller = await prisma.sellerProfile.create({
    data: {
      userId: user.id,
      shopName: 'Fixture Store',
      slug: 'fixture-store',
      status: SellerStatus.APPROVED,
      vacationMode: false,
      approvedAt: new Date(),
    },
  });

  const categoryIds = new Map<string, string>();
  for (const category of CATEGORIES) {
    const created = await prisma.category.create({
      data: {
        name: category.name,
        slug: category.slug,
        isActive: true,
        parentId: category.parent ? categoryIds.get(category.parent) : null,
      },
    });
    categoryIds.set(category.slug, created.id);
  }

  for (const name of BRANDS) {
    await prisma.brand.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
  }

  for (const spec of PRODUCTS) {
    const product = await prisma.product.create({
      data: {
        sellerId: seller.id,
        categoryId: categoryIds.get(spec.categorySlug)!,
        title: spec.title,
        slug: spec.slug,
        description: spec.description ?? `${spec.title} from the search test fixture.`,
        brand: spec.brand,
        basePricePaise: spec.pricePaise,
        ratingAvg: spec.ratingAvg,
        ratingCount: spec.ratingCount,
        soldCount: spec.soldCount,
        status: spec.status ?? ProductStatus.APPROVED,
        isVisible: spec.isVisible ?? true,
        approvedAt: new Date(),
      },
    });
    await prisma.productImage.create({
      data: { productId: product.id, url: `/uploads/fixture/${spec.slug}.jpg`, sortOrder: 0 },
    });
    await prisma.productVariant.create({
      data: {
        productId: product.id,
        // A real size, not 'One Size' — that string is a legacy sentinel the
        // variant normaliser drops on purpose, so it would produce no facet.
        optionValues: { size: 'M' },
        optionsKey: 'size:M',
        label: 'M',
        size: 'M',
        color: '',
        sku: `SKU-${spec.slug}`,
        pricePaise: spec.pricePaise,
        stock: 10,
      },
    });
  }
}
