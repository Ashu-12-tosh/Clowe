/**
 * One-off: move private files out of the public uploads folder.
 *
 * Return photos, try-on photos and results, and packing videos used to be
 * written to the public uploads folder and stored as URLs. For every row
 * whose column still holds one of those URLs, this moves the file into
 * private storage as an asset owned by that row's user, rewrites the column
 * to the asset reference, and deletes the public copy.
 *
 * Left alone: anything that is not a file this API wrote — the seeded demo
 * history's stock-photo URLs and the demo catalog's /uploads/demo/ files go
 * with the demo catalog, not through here. Files that are already gone are
 * reported and their rows left as they are.
 *
 * Dry run by default; pass --apply to do it. Safe to run again: rewritten
 * rows hold references, which are skipped.
 *
 *   npm run db:backfill-private-files -w @clowe/api              # dry run
 *   npm run db:backfill-private-files -w @clowe/api -- --apply
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AssetPurpose } from '@prisma/client';
import { isAssetRef } from '@clowe/shared';
// env first: it layers .env.local over .env, and nothing may load .env before it.
import { env } from '../src/env';
import { prisma } from '../src/db';
import { storePrivateFile } from '../src/services/assets';
import { uploadDir } from '../src/routes/uploads';

const CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/** The bare filename of an upload this API wrote (flat, no sub-folder), or null. */
function ownFlatUpload(value: string | null): string | null {
  if (!value || isAssetRef(value)) return null;
  const prefix = `${env.API_PUBLIC_URL}/uploads/`;
  const rest = value.startsWith(prefix) ? value.slice(prefix.length) : value.startsWith('/uploads/') ? value.slice('/uploads/'.length) : null;
  if (rest === null || !/^[\w-]+\.[a-z0-9]+$/i.test(rest)) return null;
  return rest;
}

interface Use {
  table: string;
  rowId: string;
  ownerId: string | null;
  purpose: AssetPurpose;
  file: string;
  /** Writes the new reference into the row, given the old value. */
  rewrite: (ref: string) => Promise<unknown>;
}

async function collect(): Promise<Use[]> {
  const uses: Use[] = [];

  for (const u of await prisma.user.findMany({ where: { tryOnPhotoUrl: { not: null } }, select: { id: true, tryOnPhotoUrl: true } })) {
    const file = ownFlatUpload(u.tryOnPhotoUrl);
    if (file) {
      uses.push({
        table: 'users.tryOnPhotoUrl', rowId: u.id, ownerId: u.id, purpose: 'TRYON_PHOTO', file,
        rewrite: (ref) => prisma.user.update({ where: { id: u.id }, data: { tryOnPhotoUrl: ref } }),
      });
    }
  }

  for (const h of await prisma.tryOnHistory.findMany({ select: { id: true, userId: true, inputImageUrl: true, resultImageUrl: true } })) {
    const input = ownFlatUpload(h.inputImageUrl);
    if (input) {
      uses.push({
        table: 'tryon_history.inputImageUrl', rowId: h.id, ownerId: h.userId, purpose: 'TRYON_PHOTO', file: input,
        rewrite: (ref) => prisma.tryOnHistory.update({ where: { id: h.id }, data: { inputImageUrl: ref } }),
      });
    }
    const result = ownFlatUpload(h.resultImageUrl);
    if (result) {
      uses.push({
        table: 'tryon_history.resultImageUrl', rowId: h.id, ownerId: h.userId, purpose: 'TRYON_RESULT', file: result,
        rewrite: (ref) => prisma.tryOnHistory.update({ where: { id: h.id }, data: { resultImageUrl: ref } }),
      });
    }
  }

  for (const r of await prisma.return.findMany({ where: { photos: { isEmpty: false } }, select: { id: true, userId: true, photos: true } })) {
    r.photos.forEach((photo, index) => {
      const file = ownFlatUpload(photo);
      if (!file) return;
      uses.push({
        table: 'returns.photos', rowId: r.id, ownerId: r.userId, purpose: 'RETURN_PHOTO', file,
        rewrite: async (ref) => {
          // Re-read: an earlier photo of the same return may already be rewritten.
          const current = await prisma.return.findUniqueOrThrow({ where: { id: r.id }, select: { photos: true } });
          const photos = [...current.photos];
          photos[index] = ref;
          return prisma.return.update({ where: { id: r.id }, data: { photos } });
        },
      });
    });
  }

  for (const p of await prisma.product.findMany({
    where: { packingVideoUrl: { not: null } },
    select: { id: true, packingVideoUrl: true, seller: { select: { userId: true } } },
  })) {
    const file = ownFlatUpload(p.packingVideoUrl);
    if (file) {
      uses.push({
        table: 'products.packingVideoUrl', rowId: p.id, ownerId: p.seller.userId, purpose: 'PACKING_VIDEO', file,
        rewrite: (ref) => prisma.product.update({ where: { id: p.id }, data: { packingVideoUrl: ref } }),
      });
    }
  }
  return uses;
}

export interface BackfillSummary {
  values: number;
  files: number;
  moved: number;
  missing: number;
}

export async function backfillPrivateFiles(apply: boolean): Promise<BackfillSummary> {
  const uses = await collect();
  const byFile = new Map<string, Use[]>();
  for (const use of uses) byFile.set(use.file, [...(byFile.get(use.file) ?? []), use]);

  console.log(`${apply ? 'apply' : 'DRY RUN'}: ${uses.length} row value(s) point at ${byFile.size} public file(s) that should be private.`);
  const counts = new Map<string, number>();
  for (const use of uses) counts.set(use.table, (counts.get(use.table) ?? 0) + 1);
  for (const [table, n] of counts) console.log(`  ${table}: ${n}`);

  let moved = 0;
  let missing = 0;
  for (const [file, users] of byFile) {
    const owners = new Set(users.map((u) => u.ownerId));
    if (owners.size > 1) {
      console.log(`  note: ${file} is used by ${owners.size} different users; it is owned by the first, the others can still see it`);
    }
    const publicPath = path.join(uploadDir, file);
    const contentType = CONTENT_TYPE[path.extname(file).toLowerCase()];
    let body: Buffer;
    try {
      body = await fs.readFile(publicPath);
    } catch {
      missing += 1;
      console.log(`  missing: ${file} (${users.map((u) => u.table).join(', ')}) - rows left as they are`);
      continue;
    }
    if (!contentType) {
      console.log(`  skipped: ${file} - unknown type`);
      continue;
    }
    if (!apply) {
      console.log(`  would move: ${file} -> ${users[0].purpose} (${users.length} row value(s))`);
      continue;
    }
    // One asset per file, owned by the first row's user; the rows that share
    // it (a saved photo and the history it was used in) are the same person.
    const stored = await storePrivateFile({ purpose: users[0].purpose, ownerId: users[0].ownerId, body, contentType });
    for (const use of users) await use.rewrite(stored.ref);
    await fs.rm(publicPath, { force: true });
    moved += 1;
    console.log(`  moved: ${file} -> ${stored.ref}`);
  }
  console.log(apply ? `Done: ${moved} moved, ${missing} missing.` : `Nothing changed. Re-run with --apply.`);
  return { values: uses.length, files: byFile.size, moved, missing };
}

// Run as a script; importing it (the test does) runs nothing.
if (/backfillPrivateFiles\.ts$/.test(process.argv[1] ?? '')) {
  backfillPrivateFiles(process.argv.includes('--apply'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
