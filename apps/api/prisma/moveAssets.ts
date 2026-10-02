/**
 * One-off: move stored private files to the configured provider.
 *
 * New private files go wherever STORAGE_PROVIDER points; files stored before
 * a switch stay where they were (and stay readable there). After setting the
 * R2 keys, this copies each older file into R2, checks the copy, points the
 * asset at it, and deletes the original. Deleted assets are skipped.
 *
 * Dry run by default; pass --apply to do it. Safe to re-run: moved assets
 * already name the target provider and are skipped.
 *
 *   dc exec api npx tsx prisma/moveAssets.ts             # dry run
 *   dc exec api npx tsx prisma/moveAssets.ts --apply
 */
// env first: it layers .env.local over .env, and nothing may load .env before it.
import '../src/env';
import { prisma } from '../src/db';
import { privateStorage, storageFor, type StorageProvider } from '../src/services/storage';

export interface MoveSummary {
  pending: number;
  moved: number;
  failed: number;
}

export async function moveAssets(target: StorageProvider, apply: boolean): Promise<MoveSummary> {
  const pending = await prisma.asset.findMany({
    where: { deletedAt: null, provider: { not: target.name } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${pending.length} file(s) to move to ${target.name}.`);
  let moved = 0;
  let failed = 0;
  for (const asset of pending) {
    if (!apply) {
      console.log(`  would move: ${asset.key} (${asset.provider} -> ${target.name}, ${asset.bytes} bytes)`);
      continue;
    }
    try {
      const source = storageFor(asset.provider);
      const body = await source.get(asset.key);
      await target.put(asset.key, body, asset.contentType);
      // Read it back before the original goes.
      const copy = await target.get(asset.key);
      if (!copy.equals(body)) throw new Error('the copy does not match the original');
      await prisma.asset.update({ where: { id: asset.id }, data: { provider: target.name } });
      await source.delete(asset.key);
      moved += 1;
      console.log(`  moved: ${asset.key}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAILED: ${asset.key} - ${err instanceof Error ? err.message : err} (left where it was)`);
    }
  }
  console.log(apply ? `Done: ${moved} moved, ${failed} failed.` : 'Nothing changed. Re-run with --apply.');
  return { pending: pending.length, moved, failed };
}

// Run as a script; importing it (the test does) runs nothing.
if (/moveAssets\.ts$/.test(process.argv[1] ?? '')) {
  moveAssets(privateStorage, process.argv.includes('--apply'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
