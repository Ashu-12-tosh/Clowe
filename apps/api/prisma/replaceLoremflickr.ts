/**
 * One-off, temporary: point demo images at picsum instead of loremflickr.
 *
 * loremflickr now answers every request with 401, so every demo image
 * hot-linked from it is broken. This rewrites those URLs to picsum's seeded
 * images, keeping each one's width and height. The seed is the product id
 * (plus the image's position), so a product keeps the same pictures every
 * time; categories, banners, tiles and brands are seeded by their own id.
 *
 * Only loremflickr URLs are touched. The whole demo catalog goes at launch,
 * and this with it.
 *
 * Dry run by default; pass --apply to write. Safe to re-run.
 *
 *   dc exec api npx tsx prisma/replaceLoremflickr.ts
 *   dc exec api npx tsx prisma/replaceLoremflickr.ts --apply
 */
// env first: it layers .env.local over .env, and nothing may load .env before it.
import '../src/env';
import { prisma } from '../src/db';

const LOREMFLICKR = 'https://loremflickr.com/';

/** The picsum image standing in for a loremflickr one, same size, stable for `seed`. */
export function picsumFor(url: string, seed: string): string {
  const size = /^https:\/\/loremflickr\.com\/(?:g\/)?(\d{1,4})\/(\d{1,4})(?:[/?]|$)/.exec(url);
  const [width, height] = size ? [size[1], size[2]] : ['800', '1000'];
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${width}/${height}`;
}

interface Change {
  table: string;
  id: string;
  from: string;
  to: string;
  write: () => Promise<unknown>;
}

async function plan(): Promise<Change[]> {
  const changes: Change[] = [];
  const where = { startsWith: LOREMFLICKR };

  for (const img of await prisma.productImage.findMany({ where: { url: where }, select: { id: true, productId: true, sortOrder: true, url: true } })) {
    const to = picsumFor(img.url, `${img.productId}-${img.sortOrder}`);
    changes.push({ table: 'product_images', id: img.id, from: img.url, to, write: () => prisma.productImage.update({ where: { id: img.id }, data: { url: to } }) });
  }
  for (const img of await prisma.productVariantImage.findMany({
    where: { url: where },
    select: { id: true, sortOrder: true, url: true, variant: { select: { id: true, productId: true } } },
  })) {
    const to = picsumFor(img.url, `${img.variant.productId}-${img.variant.id}-${img.sortOrder}`);
    changes.push({ table: 'product_variant_images', id: img.id, from: img.url, to, write: () => prisma.productVariantImage.update({ where: { id: img.id }, data: { url: to } }) });
  }
  for (const c of await prisma.category.findMany({ where: { imageUrl: where }, select: { id: true, imageUrl: true } })) {
    const to = picsumFor(c.imageUrl!, `category-${c.id}`);
    changes.push({ table: 'categories', id: c.id, from: c.imageUrl!, to, write: () => prisma.category.update({ where: { id: c.id }, data: { imageUrl: to } }) });
  }
  for (const b of await prisma.categoryBanner.findMany({ where: { imageUrl: where }, select: { id: true, imageUrl: true } })) {
    const to = picsumFor(b.imageUrl!, `category-banner-${b.id}`);
    changes.push({ table: 'category_banners', id: b.id, from: b.imageUrl!, to, write: () => prisma.categoryBanner.update({ where: { id: b.id }, data: { imageUrl: to } }) });
  }
  for (const b of await prisma.homeBanner.findMany({ where: { imageUrl: where }, select: { id: true, imageUrl: true } })) {
    const to = picsumFor(b.imageUrl!, `home-banner-${b.id}`);
    changes.push({ table: 'home_banners', id: b.id, from: b.imageUrl!, to, write: () => prisma.homeBanner.update({ where: { id: b.id }, data: { imageUrl: to } }) });
  }
  for (const t of await prisma.promoTile.findMany({ where: { imageUrl: where }, select: { id: true, imageUrl: true } })) {
    const to = picsumFor(t.imageUrl!, `promo-tile-${t.id}`);
    changes.push({ table: 'promo_tiles', id: t.id, from: t.imageUrl!, to, write: () => prisma.promoTile.update({ where: { id: t.id }, data: { imageUrl: to } }) });
  }
  for (const b of await prisma.brand.findMany({ where: { logoUrl: where }, select: { id: true, logoUrl: true } })) {
    const to = picsumFor(b.logoUrl!, `brand-${b.id}`);
    changes.push({ table: 'brands', id: b.id, from: b.logoUrl!, to, write: () => prisma.brand.update({ where: { id: b.id }, data: { logoUrl: to } }) });
  }
  return changes;
}

export async function replaceLoremflickr(apply: boolean): Promise<{ found: number; written: number }> {
  const changes = await plan();
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${changes.length} loremflickr URL(s) to point at picsum.`);
  const byTable = new Map<string, number>();
  for (const c of changes) byTable.set(c.table, (byTable.get(c.table) ?? 0) + 1);
  for (const [table, n] of byTable) console.log(`  ${table}: ${n}`);
  for (const c of changes.slice(0, 3)) console.log(`  e.g. ${c.from} -> ${c.to}`);
  let written = 0;
  if (apply) {
    for (const c of changes) {
      await c.write();
      written += 1;
    }
  }
  console.log(apply ? `Done: ${written} rewritten.` : 'Nothing changed. Re-run with --apply.');
  return { found: changes.length, written };
}

// Run as a script; importing it (the test does) runs nothing.
if (/replaceLoremflickr\.ts$/.test(process.argv[1] ?? '')) {
  replaceLoremflickr(process.argv.includes('--apply'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
