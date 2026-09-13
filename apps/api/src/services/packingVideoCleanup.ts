import { prisma } from '../db';
import { removeUploadByUrl } from '../routes/uploads';

/**
 * Packing videos are proof-of-packing clips sellers upload with a listing.
 * They are only needed around the review window, so they expire: after this
 * many days the file is deleted and the listing's reference cleared.
 */
export const PACKING_VIDEO_RETENTION_DAYS = 10;

/** Delete every packing video past its retention; returns how many were removed. */
export async function sweepExpiredPackingVideos(): Promise<number> {
  const cutoff = new Date(Date.now() - PACKING_VIDEO_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const due = await prisma.product.findMany({
    where: { packingVideoUrl: { not: null }, packingVideoUploadedAt: { lt: cutoff } },
    select: { id: true, packingVideoUrl: true },
  });
  if (due.length === 0) return 0;

  for (const product of due) {
    if (product.packingVideoUrl) removeUploadByUrl(product.packingVideoUrl);
  }
  await prisma.product.updateMany({
    where: { id: { in: due.map((p) => p.id) } },
    data: { packingVideoUrl: null, packingVideoUploadedAt: null },
  });
  return due.length;
}

/** Run once at boot, then hourly. Failures are logged, never fatal. */
export function startPackingVideoCleanup(): void {
  const run = () => {
    sweepExpiredPackingVideos()
      .then((removed) => {
        if (removed > 0) console.log(`[clowe-api] expired packing videos removed: ${removed}`);
      })
      .catch((err) => console.error('[clowe-api] packing video sweep failed:', err));
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}
