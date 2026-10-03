import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { FIXTURE, seedFixture } from '../test/fixture';
import { invalidateSearchCatalog } from '../services/productSearch';
import { invalidateCategoryRules } from '../services/categoryRules';

/**
 * Product names are not split by search. "books" is the Books category, not a
 * laptop called "Book Go", a "Bookshelf" or an "AirBook"; "book" typed into
 * the search bar never offers AirBook or CoreBook. A category word, singular
 * or plural, is understood as that category — for ranking.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

const NAMES = {
  bookGo: 'names-zenlite-book-go',
  airBook: 'names-novatech-airbook',
  coreBook: 'names-novatech-corebook',
  bookshelf: 'names-casa-bookshelf',
  plainLaptop: 'names-vertex-flex-laptop',
  stand: 'names-novatech-laptop-stand',
  plantStand: 'names-casa-plant-stand',
};

beforeAll(async () => {
  await seedFixture(prisma);
  const electronics = await prisma.category.findUniqueOrThrow({ where: { slug: 'electronics' } });
  const laptops = await prisma.category.create({
    data: { name: 'Laptops', slug: 'electronics-laptops', isActive: true, parentId: electronics.id },
  });
  const furniture = await prisma.category.create({ data: { name: 'Furniture', slug: 'furniture', isActive: true } });
  const user = await prisma.user.create({ data: { phone: '9191000001', name: 'Names Seller', role: Role.SELLER, referralCode: 'NAMES-S' } });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'Names Shop', status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  const products: [string, string, string][] = [
    [NAMES.bookGo, 'Zenlite Book Go 15 Laptop', laptops.id],
    [NAMES.airBook, 'NovaTech AirBook Slim Laptop', laptops.id],
    [NAMES.coreBook, 'NovaTech CoreBook Pro Laptop', laptops.id],
    [NAMES.plainLaptop, 'Vertex Flex 14 Laptop', laptops.id],
    [NAMES.bookshelf, 'Casa Nova Bookshelf 5-Tier', furniture.id],
    [NAMES.stand, 'NovaTech Laptop Stand Aluminium', furniture.id],
    [NAMES.plantStand, 'Casa Nova Plant Stand', furniture.id],
  ];
  for (const [i, [slug, title, categoryId]] of products.entries()) {
    const p = await prisma.product.create({
      data: {
        sellerId: seller.id, categoryId, title, slug, description: 'Search names test product.',
        basePricePaise: 100_000, status: ProductStatus.APPROVED, approvedAt: new Date(),
      },
    });
    await prisma.productVariant.create({ data: { productId: p.id, optionValues: {}, sku: `NAMES-${i}`, pricePaise: 100_000, stock: 5 } });
  }
  invalidateSearchCatalog();
  invalidateCategoryRules();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function search(q: string) {
  const res = await fetch(`${base}/api/products?q=${encodeURIComponent(q)}&limit=48`);
  const json = (await res.json()) as {
    data: { items: { slug: string }[]; search?: { strategy: string; parsed: { filters: { inferredCategorySlug?: string } } } };
  };
  return { slugs: json.data.items.map((i) => i.slug), search: json.data.search };
}

async function suggested(q: string): Promise<string[]> {
  const res = await fetch(`${base}/api/search/suggest?q=${encodeURIComponent(q)}`);
  const json = (await res.json()) as { data: { products: { slug: string }[] } };
  return json.data.products.map((p) => p.slug);
}

describe('"books" is the category, not a product name', () => {
  it('lists the books first, and never the Bookshelf or the AirBook', async () => {
    const { slugs, search: meta } = await search('books');
    expect(meta?.strategy).toBe('category');
    expect(slugs[0]).toBe(FIXTURE.book);
    expect(slugs).not.toContain(NAMES.bookshelf);
    expect(slugs).not.toContain(NAMES.airBook);
    expect(slugs).not.toContain(NAMES.coreBook);
    // A laptop named "Book Go" may follow, but below every book.
    const bookGo = slugs.indexOf(NAMES.bookGo);
    if (bookGo >= 0) expect(bookGo).toBeGreaterThan(slugs.indexOf(FIXTURE.book));
  });

  it('keeps one-word names whole: "airbook" finds the AirBook, and only it', async () => {
    expect((await search('airbook')).slugs).toEqual([NAMES.airBook]);
  });

  it('reads "notebook" as a laptop, so every laptop comes back', async () => {
    const { slugs } = await search('notebook');
    for (const slug of [NAMES.bookGo, NAMES.airBook, NAMES.coreBook, NAMES.plainLaptop]) expect(slugs).toContain(slug);
    expect(slugs).not.toContain(NAMES.bookshelf);
  });
});

describe('the type-ahead never cuts into a word', () => {
  it('"book" offers words that start with it, not AirBook or CoreBook', async () => {
    const slugs = await suggested('book');
    expect(slugs).toContain(NAMES.bookshelf);
    expect(slugs).toContain(NAMES.bookGo);
    expect(slugs).not.toContain(NAMES.airBook);
    expect(slugs).not.toContain(NAMES.coreBook);
  });
});

describe('a category word, singular or plural, is understood as the category', () => {
  it('"book" is the Books category, as "books" is', async () => {
    const { slugs, search: meta } = await search('book');
    expect(meta?.parsed.filters.inferredCategorySlug).toBe('books');
    expect(slugs[0]).toBe(FIXTURE.book);
    expect(slugs).not.toContain(NAMES.airBook);
  });

  it('"laptop" infers Laptops for ranking, and hides nothing the word finds', async () => {
    const { slugs, search: meta } = await search('laptop');
    expect(meta?.parsed.filters.inferredCategorySlug).toBe('electronics-laptops');
    for (const slug of [NAMES.bookGo, NAMES.airBook, NAMES.coreBook, NAMES.plainLaptop]) expect(slugs).toContain(slug);
  });

  it('"laptop stand" still needs both words: the stand, not every laptop', async () => {
    const { slugs, search: meta } = await search('laptop stand');
    expect(meta?.parsed.filters.inferredCategorySlug).toBe('electronics-laptops');
    expect(slugs).toEqual([NAMES.stand]);
  });
});
