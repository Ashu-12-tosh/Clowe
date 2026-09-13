/**
 * Creates one properly photographed, try-on-ready listing.
 *
 * The seeded catalog uses random stock photos (loremflickr / picsum), which is
 * fine for layout but useless for judging AI try-on — the "garment" is often a
 * landscape or an animal, so the model has nothing to fit. This adds a real
 * flat-lay garment photo with a real name, priced above the try-on threshold,
 * in a try-on-eligible category, so the feature can actually be evaluated.
 *
 * Idempotent: re-running updates the listing in place.
 *
 *   npm run seed:tryon-demo --workspace=@clowe/api
 */
import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { uploadDir } from '../src/routes/uploads';

const prisma = new PrismaClient();

/**
 * Source photo, fetched once if the cropped file is not already on disk.
 * `uploads/` is gitignored, so a fresh clone has to rebuild it.
 *
 * "White crew neck t-shirt" by Mediamodifier on Unsplash, free to use under
 * the Unsplash License. The crop isolates the garment from the flat-lay props
 * around it, which is what the try-on model wants.
 */
const SOURCE_URL =
  'https://images.unsplash.com/photo-1620799139507-2a76f79a2f4d?fm=jpg&q=80&w=1200&auto=format&fit=crop';
const SOURCE_CROP = { left: 292, top: 118, width: 540, height: 660 };

/** Fetch + crop the garment photo unless it is already there. */
async function ensureGarmentPhoto(file: string): Promise<void> {
  if (fs.existsSync(file)) return;
  console.log('Garment photo missing — fetching it once…');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Could not download the garment photo (HTTP ${res.status})`);
  await sharp(Buffer.from(await res.arrayBuffer()))
    .extract(SOURCE_CROP)
    // Square, so it fills the product page's 1:1 frame without cropping.
    .resize({ width: 1000, height: 1000, fit: 'contain', background: '#f4f4f4' })
    .jpeg({ quality: 92 })
    .toFile(file);
  console.log(`  saved ${file}`);
}

const SLUG = 'truethread-essential-v-neck-tee';
/**
 * Lives under <UPLOAD_DIR>/catalog and is served at /uploads/catalog/….
 * /uploads is served immutable with a 7-day cache, so a changed photo needs a
 * new filename — overwriting this path leaves browsers on the old image.
 */
const IMAGE_PATH = '/uploads/catalog/essential-v-neck-white-1000.jpg';

const SIZES = ['S', 'M', 'L', 'XL'];
const PRICE_PAISE = 249900; // ₹2,499 — above the ₹2,000 try-on threshold
const MRP_PAISE = 399900;

async function main() {
  await ensureGarmentPhoto(path.join(uploadDir, 'catalog', 'essential-v-neck-white-1000.jpg'));

  // A try-on-eligible category, a seller with credits, and an apparel brand.
  const category = await prisma.category.findUnique({ where: { slug: 'fashion-men' } });
  if (!category) throw new Error('Category fashion-men not found — run the main seed first');

  const seller = await prisma.sellerProfile.findFirst({
    where: { status: 'APPROVED', vacationMode: false },
    orderBy: { tryOnCredits: 'desc' },
  });
  if (!seller) throw new Error('No approved seller found — run the main seed first');

  const brand = await prisma.brand.findFirst({ where: { name: 'TrueThread' } });

  const data = {
    sellerId: seller.id,
    categoryId: category.id,
    title: 'Essential V-Neck Cotton T-Shirt',
    description:
      'A clean-cut everyday tee in 100% combed cotton. The V-neck sits flat without gaping, ' +
      'the shoulders are cut straight for a regular fit, and the fabric is pre-shrunk so it ' +
      'keeps its shape after a wash. Wears well on its own or layered under a jacket.',
    shortDescription: 'Regular-fit V-neck tee in pre-shrunk combed cotton.',
    brand: 'TrueThread',
    brandId: brand?.id ?? null,
    basePricePaise: PRICE_PAISE,
    mrpPaise: MRP_PAISE,
    highlights: [
      '100% combed cotton, 180 GSM',
      'Pre-shrunk — holds its shape after washing',
      'Flat-lock seams, no shoulder tape rub',
      'Regular fit with a straight hem',
    ],
    attributes: [
      { key: 'fabric', label: 'Fabric', value: '100% Combed Cotton' },
      { key: 'fit', label: 'Fit', value: 'Regular' },
      { key: 'pattern', label: 'Pattern', value: 'Solid' },
      { key: 'sleeve', label: 'Sleeve length', value: 'Half sleeve' },
      { key: 'occasion', label: 'Occasion', value: 'Casual' },
      { key: 'wash_care', label: 'Wash care', value: 'Machine wash cold, tumble dry low' },
      { key: 'country_of_origin', label: 'Country of origin', value: 'India' },
    ],
    tags: ['t-shirt', 'v-neck', 'cotton', 'casual', 'try-on'],
    isVisible: true,
    tryOnEnabled: true,
    status: ProductStatus.APPROVED,
    approvedAt: new Date(),
    isNew: true,
    weightGrams: 220,
    taxRatePercent: 5,
  };

  const product = await prisma.product.upsert({
    where: { slug: SLUG },
    create: { ...data, slug: SLUG },
    update: data,
  });

  // One image, replaced wholesale so a re-run cannot stack duplicates.
  await prisma.productImage.deleteMany({ where: { productId: product.id } });
  await prisma.productImage.create({
    data: { productId: product.id, url: IMAGE_PATH, sortOrder: 0 },
  });

  // One variant per size, all white. optionsKey is what the unique index uses.
  for (const size of SIZES) {
    const optionValues = { color: 'White', size };
    const optionsKey = `color:White|size:${size}`;
    await prisma.productVariant.upsert({
      where: { productId_optionsKey: { productId: product.id, optionsKey } },
      create: {
        productId: product.id,
        optionValues,
        optionsKey,
        label: `White · ${size}`,
        size,
        color: 'White',
        sku: `TT-VNECK-WHT-${size}`,
        pricePaise: PRICE_PAISE,
        mrpPaise: MRP_PAISE,
        stock: 25,
      },
      update: { pricePaise: PRICE_PAISE, mrpPaise: MRP_PAISE, stock: 25, label: `White · ${size}` },
    });
  }

  console.log(`Listed: ${product.title}`);
  console.log(`  seller   : ${seller.shopName} (${seller.tryOnCredits} try-on credits)`);
  console.log(`  price    : ₹${PRICE_PAISE / 100}  (try-on needs ₹2,000+)`);
  console.log(`  sizes    : ${SIZES.join(', ')}`);
  console.log(`  photo    : ${IMAGE_PATH}`);
  console.log(`  open at  : /products/${SLUG}`);
  console.log(`  try-on   : /products/${SLUG}?tryon=1`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
