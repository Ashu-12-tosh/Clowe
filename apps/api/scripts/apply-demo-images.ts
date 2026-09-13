// Replace placeholder (picsum) product images with real clothing/fashion
// demo photos (Unsplash), downloaded into /uploads and matched by category.
// Idempotent — run any time with: npx tsx scripts/apply-demo-images.ts
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? 'uploads');
const PUBLIC_URL = process.env.API_PUBLIC_URL ?? 'http://localhost:4400';

const u = (id: string) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=600&h=800&q=80`;

// Category slug → clothing photo pool (model/product shots).
const POOLS: Record<string, string[]> = {
  'men-t-shirts': [
    u('1521572163474-6864f9cf17ab'),
    u('1576566588028-4147f3842f27'),
    u('1503341504253-dff4815485f1'),
    u('1618354691373-d851c5c3a990'),
    u('1523381210434-271e8be1f52b'),
  ],
  'men-shirts': [
    u('1602810318383-e386cc2a3ccf'),
    u('1607345366928-199ea26cfe3e'),
    u('1596755094514-f87e34085b2c'),
    u('1620799140408-edc6dcb6d633'),
  ],
  'men-jeans': [
    u('1542272604-787c3835535d'),
    u('1541099649105-f69ad21f3246'),
    u('1565084888279-aca607ecce0c'),
  ],
  'men-jackets': [
    u('1551028719-00167b16eac5'),
    u('1591047139829-d91aecb6caea'),
    u('1544441893-675973e31985'),
    u('1617137968427-85924c800a22'),
  ],
  'women-dresses': [
    u('1595777457583-95e059d581b8'),
    u('1572804013309-59a88b7e92f1'),
    u('1515372039744-b8f02a3ae446'),
    u('1551537482-f2075a1d41f2'),
    u('1496747611176-843222e1e57c'),
  ],
  'women-tops': [
    u('1554568218-0f1715e72254'),
    u('1434389677669-e08b4cac3105'),
    u('1490481651871-ab68de25d43d'),
    u('1594633312681-425c7b97ccd1'),
    u('1622470953794-aa9c70b0fb9d'),
  ],
  'women-kurtis': [
    u('1583744946564-b52ac1c389c8'),
    u('1585487000160-6ebcfceb0d03'),
    u('1571945153237-4929e783af4a'),
  ],
  'women-sarees': [u('1583744946564-b52ac1c389c8'), u('1612336307429-8a898d10e223')],
  'kids-boys': [
    u('1503919545889-aef636e10ad4'),
    u('1519238263530-99bdd11df2ea'),
    u('1617627143750-d86bc21e42bb'),
  ],
  'kids-girls': [
    u('1622290291468-a28f7a7dc6a8'),
    u('1624378439575-d8705ad7ae80'),
    u('1588117260148-b47818741c74'),
  ],
};
const FALLBACK = [
  u('1523381210434-271e8be1f52b'),
  u('1596783074918-c84cb06531ca'),
  u('1610652492500-ded49ceeb378'),
];

function isJpeg(buf: Buffer): boolean {
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Download one remote image into /uploads (cached by filename). */
async function download(url: string, index: number): Promise<string | null> {
  const filename = `demo-${url.match(/photo-([a-z0-9-]+)\?/)?.[1] ?? index}.jpg`;
  const filePath = path.join(UPLOAD_DIR, filename);
  try {
    await fs.access(filePath);
    return filename; // already downloaded
  } catch {
    /* not cached yet */
  }
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isJpeg(buf)) return null;
    await fs.writeFile(filePath, buf);
    return filename;
  } catch {
    return null;
  }
}

async function main() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  // 1. Download every pool image once.
  const localByUrl = new Map<string, string>();
  const allUrls = [...new Set([...Object.values(POOLS).flat(), ...FALLBACK])];
  let i = 0;
  for (const url of allUrls) {
    const filename = await download(url, i++);
    if (filename) localByUrl.set(url, filename);
  }
  console.log(`[demo-images] downloaded/cached ${localByUrl.size}/${allUrls.length} photos`);

  // 2. Re-point products that still use placeholder (picsum) images.
  const products = await prisma.product.findMany({
    include: {
      category: { select: { slug: true } },
      images: { orderBy: { sortOrder: 'asc' } },
    },
  });

  const counters: Record<string, number> = {};
  let updated = 0;
  for (const product of products) {
    const usesPlaceholder = product.images.some((img) => img.url.includes('picsum.photos'));
    if (!usesPlaceholder) continue; // seller-uploaded photos stay untouched

    const pool = (POOLS[product.category.slug] ?? FALLBACK)
      .map((url) => localByUrl.get(url))
      .filter((f): f is string => !!f);
    if (pool.length === 0) continue;

    // Rotate through the pool so products in a category get different photos.
    const offset = counters[product.category.slug] ?? 0;
    counters[product.category.slug] = offset + 1;
    const picks = [pool[offset % pool.length], pool[(offset + 1) % pool.length]];

    await prisma.$transaction([
      prisma.productImage.deleteMany({ where: { productId: product.id } }),
      prisma.productImage.createMany({
        data: [...new Set(picks)].map((filename, sortOrder) => ({
          productId: product.id,
          url: `${PUBLIC_URL}/uploads/${filename}`,
          altText: product.title,
          sortOrder,
        })),
      }),
    ]);
    updated++;
  }
  console.log(`[demo-images] updated ${updated} products (seller-uploaded photos untouched)`);
}

main()
  .catch((err) => {
    console.error('[demo-images] failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
