import { assetRef, TRYON_PHOTO_RETENTION_HOURS } from '@clowe/shared';
import { prisma } from '../db';
import { deleteFileRef } from './assets';

/**
 * Shoppers' try-on photos are personal data, kept 24 hours after upload —
 * saved for reuse or not (Privacy Policy 3.7) — then deleted. The history row
 * stays; its photo resolves to "gone".
 *
 * The sweep works from the assets table, so only files we stored privately
 * are ever touched. Rows whose photo is not one of ours (the seeded demo
 * history points at a stock-photo host) have no asset and are never seen
 * here; they go with the demo catalog.
 */
export { TRYON_PHOTO_RETENTION_HOURS };

/** Every try-on photo a shopper has, deleted now (consent withdrawn); returns how many. */
export async function deleteTryOnPhotosOf(userId: string): Promise<number> {
  const assets = await prisma.asset.findMany({
    where: { purpose: 'TRYON_PHOTO', deletedAt: null, ownerId: userId },
    select: { id: true },
  });
  let removed = 0;
  for (const a of assets) {
    await deleteFileRef(assetRef(a.id));
    removed += 1;
  }
  return removed;
}

/** Delete every try-on photo past retention that nobody has saved; returns how many. */
export async function sweepExpiredTryOnPhotos(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRYON_PHOTO_RETENTION_HOURS * 60 * 60 * 1000);
  const due = await prisma.asset.findMany({
    where: { purpose: 'TRYON_PHOTO', deletedAt: null, createdAt: { lt: cutoff } },
    select: { id: true },
    take: 500,
  });
  if (due.length === 0) return 0;

  // Saved photos too (Privacy Policy 3.7): the saved reference goes with it.
  const refs = due.map((a) => assetRef(a.id));
  await prisma.user.updateMany({ where: { tryOnPhotoUrl: { in: refs } }, data: { tryOnPhotoUrl: null } });

  let removed = 0;
  for (const ref of refs) {
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
  // Every 10 minutes, so no photo outlives its 24 hours by more than that.
  const timer = setInterval(run, 10 * 60 * 1000);
  timer.unref();
}
