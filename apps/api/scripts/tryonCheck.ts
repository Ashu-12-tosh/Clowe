/**
 * AI Try-On preflight.
 *
 *   npm run tryon:check            -- config + credentials only, nothing billed
 *   npm run tryon:check -- --live  -- also runs one real try-on (costs credits)
 *
 * Checks the pieces in the order they fail in production: configuration, then
 * the key, then image preprocessing, then a full generation. Each step prints
 * what it proved, so a failure says which hop is broken rather than just
 * "try-on didn't work".
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/env';
import { prisma } from '../src/db';
import { uploadDir } from '../src/routes/uploads';
import { garmentCategoryFor, tryOnProvider } from '../src/services/tryon';
import { imageUrlToDataUri } from '../src/services/tryon/imageUtils';
import { getSettings } from '../src/services/settingsService';
import { categoryRulesFor } from '../src/services/categoryRules';

const live = process.argv.includes('--live');

let failures = 0;
function pass(label: string, detail = ''): void {
  console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label: string, detail: string): void {
  failures += 1;
  console.log(`  FAIL  ${label} — ${detail}`);
}
function warn(label: string, detail: string): void {
  console.log(`  warn  ${label} — ${detail}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/** Bytes in a base64 data URI, for reporting the real upload size. */
function dataUriBytes(uri: string): number {
  return Math.floor(((uri.length - uri.indexOf(',') - 1) * 3) / 4);
}

async function main(): Promise<void> {
  console.log('Clowe — AI Try-On preflight');
  console.log(live ? 'mode: LIVE (one real try-on will be billed)' : 'mode: dry (nothing billed)');

  // -- 1. Configuration -----------------------------------------------------
  section('1. Configuration');
  console.log(`  provider: ${tryOnProvider.name}`);
  if (tryOnProvider.name === 'fashn') {
    pass('FASHN_API_KEY is set', `${env.FASHN_API_KEY?.length ?? 0} chars`);
    pass('model', `${env.FASHN_MODEL}, mode=${env.FASHN_MODE}`);
    pass('run budget', `${env.TRYON_TIMEOUT_MS} ms`);
  } else if (env.TRYON_PROVIDER === 'mock') {
    warn('provider is mock', 'TRYON_PROVIDER=mock overrides the key; set it to auto for real try-on');
  } else {
    fail('provider is mock', 'FASHN_API_KEY is not set in apps/api/.env');
  }
  if (env.API_PUBLIC_URL.includes('localhost')) {
    warn(
      'API_PUBLIC_URL is localhost',
      'fine for local dev (images are sent inline), but set it to the public URL before going live',
    );
  } else {
    pass('API_PUBLIC_URL', env.API_PUBLIC_URL);
  }

  // -- 2. Credentials -------------------------------------------------------
  section('2. Credentials');
  if (tryOnProvider.verifyCredentials) {
    const check = await tryOnProvider.verifyCredentials();
    if (check.ok) pass('FASHN accepted the key', check.detail);
    else fail('FASHN rejected the key', check.detail);
  } else {
    pass('no credentials needed', 'mock provider');
  }

  // -- 3. Platform settings -------------------------------------------------
  section('3. Platform settings (admin-controlled)');
  const settings = await getSettings();
  if (settings.tryonEnabled) pass('try-on is enabled');
  else fail('try-on is disabled', 'turn it on in Admin → Try-On monitor');
  pass('daily limit per shopper', `${settings.tryonDailyLimit}`);
  pass(
    'minimum product price',
    `₹${Math.round(settings.tryonMinPricePaise / 100)} — cheaper products are not eligible`,
  );
  pass(
    'monthly budget',
    settings.tryonMonthlyBudgetPaise > 0
      ? `₹${Math.round(settings.tryonMonthlyBudgetPaise / 100)}`
      : 'unlimited',
  );

  // -- 4. An eligible product ----------------------------------------------
  section('4. Catalog readiness');
  const candidates = await prisma.product.findMany({
    where: {
      status: 'APPROVED',
      isVisible: true,
      tryOnEnabled: true,
      basePricePaise: { gte: settings.tryonMinPricePaise },
      seller: { vacationMode: false, tryOnCredits: { gt: 0 } },
      images: { some: {} },
    },
    include: {
      images: { orderBy: { sortOrder: 'asc' }, take: 1 },
      category: { select: { id: true, name: true } },
      seller: { select: { shopName: true, tryOnCredits: true } },
    },
    take: 25,
  });

  let product: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    const rules = await categoryRulesFor(candidate.category.id);
    if (rules.tryOnEligible) {
      product = candidate;
      break;
    }
  }
  if (!product) {
    fail(
      'no try-on-ready product',
      'need an APPROVED, visible product with tryOnEnabled, an image, a seller with credits, ' +
        'a price above the minimum, and a category whose rules set tryOnEligible',
    );
    return;
  }
  pass('eligible product', `${product.title} (${product.category.name})`);
  pass('seller credits', `${product.seller.tryOnCredits} left on ${product.seller.shopName}`);
  const garmentCategory = garmentCategoryFor(product.category.name, product.title);
  pass('garment category sent to the model', garmentCategory);

  // -- 5. Image preprocessing ----------------------------------------------
  section('5. Image preprocessing');
  const garmentUrl = product.images[0].url;
  let garmentUri: string;
  try {
    const started = Date.now();
    garmentUri = await imageUrlToDataUri(garmentUrl);
    pass(
      'garment image normalised',
      `${(dataUriBytes(garmentUri) / 1024).toFixed(0)} KB jpeg in ${Date.now() - started} ms`,
    );
  } catch (err) {
    fail('garment image', err instanceof Error ? err.message : String(err));
    return;
  }

  // A shopper photo: a previously saved one if any user has set one, else the
  // garment image again (enough to prove the pipeline, not to judge quality).
  const withPhoto = await prisma.user.findFirst({
    where: { tryOnPhotoUrl: { not: null } },
    select: { tryOnPhotoUrl: true },
  });
  const personUrl = withPhoto?.tryOnPhotoUrl ?? garmentUrl;
  try {
    const started = Date.now();
    const personUri = await imageUrlToDataUri(personUrl);
    pass(
      'model photo normalised',
      `${(dataUriBytes(personUri) / 1024).toFixed(0)} KB jpeg in ${Date.now() - started} ms`,
    );
  } catch (err) {
    fail('model photo', err instanceof Error ? err.message : String(err));
    return;
  }
  if (!withPhoto) {
    warn('no saved shopper photo', 'using the product image as the model photo for this check');
  }

  // -- 6. A real generation -------------------------------------------------
  section('6. Generation');
  if (!live) {
    console.log('  skipped — re-run with `-- --live` to generate one real try-on');
  } else {
    const started = Date.now();
    try {
      const resultUrl = await tryOnProvider.generate({
        personImageUrl: personUrl,
        garmentImageUrl: garmentUrl,
        productTitle: product.title,
        garmentCategory,
      });
      const elapsed = Date.now() - started;
      pass('generated', `${elapsed} ms → ${resultUrl}`);

      const filename = resultUrl.split('/uploads/')[1];
      if (!filename) {
        fail('result is not re-hosted', `expected an /uploads URL, got ${resultUrl}`);
      } else {
        const stat = await fs.stat(path.join(uploadDir, filename));
        pass('result saved locally', `${(stat.size / 1024).toFixed(0)} KB at uploads/${filename}`);
      }
    } catch (err) {
      fail('generation', err instanceof Error ? err.message : String(err));
    }
  }

  // -- Verdict --------------------------------------------------------------
  section(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`);
  if (failures === 0 && !live) {
    console.log('Run `npm run tryon:check -- --live` to prove a real generation end to end.');
  }
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
