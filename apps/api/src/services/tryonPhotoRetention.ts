import { assetRef } from '@clowe/shared';
import { prisma } from '../db';
import { deleteFileRef } from './assets';

/**
 * Shoppers' try-on photos are personal data and are kept only as long as they
 * are useful: this many days after upload, unless the shopper saved the photo
 * to reuse. The history row stays; its photo resolves to "gone".
 *
 * The sweep works from the assets table, so only files we stored privately
 * are ever touched. Rows whose photo is not one of ours (the seeded demo
 * history points at a stock-photo host) have no asset and are never seen
 * here; they go with the demo catalog.
 */
export const TRYON_PHOTO_RETENTION_DAYS = 30;

/** Delete every try-on photo past retention that nobody has saved; returns how many. */
export async function sweepExpiredTryOnPhotos(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRYON_PHOTO_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const due = await prisma.asset.findMany({
    where: { purpose: 'TRYON_PHOTO', deletedAt: null, createdAt: { lt: cutoff } },
    select: { id: true },
    take: 500,
  });
  if (due.length === 0) return 0;

  // A photo a shopper chose to keep for next time is not expired.
  const refs = due.map((a) => assetRef(a.id));
  const saved = await prisma.user.findMany({ where: { tryOnPhotoUrl: { in: refs } }, select: { tryOnPhotoUrl: true } });
  const keep = new Set(saved.map((u) => u.tryOnPhotoUrl));

  let removed = 0;
  for (const ref of refs) {
    if (keep.has(ref)) continue;
    try {
      await deleteFileRef(ref);
      removed += 1;
    } catch (err) {
      // One unreadable file never stops the rest of the sweep.
      console.error(`[clowe-api] try-on photo ${ref} not removed:`, err instanceof Error ? err.message : err);
    }
  }
  return removed;
}

/** Run once at boot, then hourly. Failures are logged, never fatal. */
export function startTryOnPhotoRetention(): void {
  const run = () => {
    sweepExpiredTryOnPhotos()
      .then((removed) => {
        if (removed > 0) console.log(`[clowe-api] expired try-on photos removed: ${removed}`);
      })
      .catch((err) => console.error('[clowe-api] try-on photo sweep failed:', err));
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}
