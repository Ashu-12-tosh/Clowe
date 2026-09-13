// Download every picsum.photos / loremflickr.com placeholder referenced by the
// database into <UPLOAD_DIR>/demo and point the rows at the local copy.
//
// Why: those hosts answer in 2-4 s per image, so a catalog page with 30
// thumbnails spent most of its load time waiting on them. Served locally they
// arrive in milliseconds, and the site works offline and through a tunnel.
//
// Safe to re-run: files already on disk are reused, rows already local are
// skipped, and a failed download leaves the row on its external URL.
//
// Run with: npm run db:localize-images --workspace=@clowe/api
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { demoImageDir, demoImageKey, isPlaceholderUrl, localDemoImageUrl } from './seed/demoImage';

const prisma = new PrismaClient();
const CONCURRENCY = Number(process.env.LOCALIZE_CONCURRENCY ?? 12);
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Every column that the seeds fill with placeholder images. */
const TARGETS: { model: string; field: string }[] = [
  { model: 'productImage', field: 'url' },
  { model: 'category', field: 'imageUrl' },
  { model: 'categoryBanner', field: 'imageUrl' },
  { model: 'homeBanner', field: 'imageUrl' },
  { model: 'promoTile', field: 'imageUrl' },
  { model: 'user', field: 'tryOnPhotoUrl' },
  { model: 'tryOnHistory', field: 'inputImageUrl' },
  { model: 'tryOnHistory', field: 'resultImageUrl' },
];

// Model + field are data-driven above, so the delegates are addressed dynamically.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

async function download(url: string): Promise<string | null> {
  const existing = localDemoImageUrl(url);
  if (existing) return existing;
  const key = demoImageKey(url);
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'clowe-dev-localize-images/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      const ext = EXT_BY_MIME[mime];
      if (!ext) throw new Error(`not an image (${mime || 'no content-type'})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error('empty body');
      const finalPath = path.join(demoImageDir, `${key}.${ext}`);
      await fs.writeFile(`${finalPath}.part`, buf);
      await fs.rename(`${finalPath}.part`, finalPath);
      return `/uploads/demo/${key}.${ext}`;
    } catch (err) {
      lastError = err;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  console.warn(`  ! ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return null;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function main() {
  await fs.mkdir(demoImageDir, { recursive: true });

  // 1. Collect every row that still points at a placeholder host.
  const rows: { model: string; field: string; id: string; url: string }[] = [];
  for (const { model, field } of TARGETS) {
    const found: Record<string, unknown>[] = await db[model].findMany({
      where: {
        OR: [
          { [field]: { startsWith: 'https://picsum.photos/' } },
          { [field]: { startsWith: 'https://loremflickr.com/' } },
        ],
      },
      select: { id: true, [field]: true },
    });
    for (const r of found) {
      const url = r[field];
      if (isPlaceholderUrl(url as string)) rows.push({ model, field, id: String(r.id), url: url as string });
    }
  }
  const urls = [...new Set(rows.map((r) => r.url))];
  console.log(`[localize-images] ${rows.length} rows, ${urls.length} distinct placeholder URLs -> ${demoImageDir}`);
  if (urls.length === 0) return;

  // 2. Download (or reuse) each distinct URL.
  const local = new Map<string, string>();
  let done = 0;
  await pool(urls, CONCURRENCY, async (url) => {
    const result = await download(url);
    if (result) local.set(url, result);
    done += 1;
    if (done % 50 === 0 || done === urls.length) console.log(`  ${done}/${urls.length} fetched (${local.size} ok)`);
  });

  // 3. Point the rows at the local copies, in transaction chunks.
  const updates = rows.filter((r) => local.has(r.url));
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    await prisma.$transaction(
      chunk.map((r) => db[r.model].update({ where: { id: r.id }, data: { [r.field]: local.get(r.url) } })),
    );
  }

  const failed = urls.length - local.size;
  console.log(
    `[localize-images] done: ${local.size} images local, ${updates.length} rows updated, ${failed} downloads failed (those rows keep their external URL).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
