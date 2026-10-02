import { PACKING_VIDEO_RETENTION_DAYS, type PackingVideoView } from '@clowe/shared';
import type { OrderStatus, ReturnStatus } from '@prisma/client';
import { prisma } from '../db';
import { removeStoredFile } from '../routes/uploads';
import { resolveFileUrl } from './assets';

/**
 * Packing videos, one per seller per order.
 *
 * A seller records what went into the box before it ships; dispatch is
 * refused until they have. The clip is private — that seller and admins, in
 * the order and return views, never the buyer — and it is evidence, so it is
 * kept for as long as it could be needed: until everything the seller sent on
 * the order has been delivered (or cancelled), then 45 days after the last
 * delivery, and for as long as any return on those items is open.
 *
 * Clips sellers attached to listings before this are left as they are: kept
 * in storage, no longer shown, and not swept.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lines not yet delivered: their clip is still needed whatever the dates say. */
const IN_FLIGHT: OrderStatus[] = ['PLACED', 'CONFIRMED', 'PACKED', 'SHIPPED'];
/** A return still being decided or handled: the clip is the evidence for it. */
const OPEN_RETURN: ReturnStatus[] = ['REQUESTED', 'APPROVED', 'RECEIVED'];

export async function hasPackingVideo(orderId: string, sellerId: string): Promise<boolean> {
  const row = await prisma.orderPackingVideo.findUnique({
    where: { orderId_sellerId: { orderId, sellerId } },
    select: { deletedAt: true },
  });
  return row !== null && row.deletedAt === null;
}

/** The clip as a viewer sees it: a signed link while the file exists. */
export async function packingVideoView(orderId: string, sellerId: string): Promise<PackingVideoView | null> {
  const row = await prisma.orderPackingVideo.findUnique({ where: { orderId_sellerId: { orderId, sellerId } } });
  if (!row) return null;
  return {
    url: row.deletedAt ? null : await resolveFileUrl(row.fileRef),
    uploadedAt: row.uploadedAt.toISOString(),
    deleted: row.deletedAt !== null,
  };
}

/**
 * When a clip may go: null while it must be kept. Everything the seller sent
 * on the order has arrived or been cancelled, no return on it is open, and
 * the last delivery was RETENTION days ago (a fully cancelled order counts
 * from the upload).
 */
export function packingVideoExpiresAt(
  uploadedAt: Date,
  items: { status: OrderStatus; deliveredAt: Date | null; return: { status: ReturnStatus } | null }[],
): Date | null {
  if (items.some((i) => IN_FLIGHT.includes(i.status))) return null;
  if (items.some((i) => i.return && OPEN_RETURN.includes(i.return.status))) return null;
  const delivered = items.map((i) => i.deliveredAt?.getTime() ?? 0);
  const anchor = Math.max(uploadedAt.getTime(), ...delivered);
  return new Date(anchor + PACKING_VIDEO_RETENTION_DAYS * DAY_MS);
}

/** Delete every clip past its retention; returns how many were removed. */
export async function sweepExpiredPackingVideos(now = new Date()): Promise<number> {
  // Nothing uploaded within the retention period can be due yet.
  const candidates = await prisma.orderPackingVideo.findMany({
    where: { deletedAt: null, uploadedAt: { lt: new Date(now.getTime() - PACKING_VIDEO_RETENTION_DAYS * DAY_MS) } },
    select: { id: true, orderId: true, sellerId: true, fileRef: true, uploadedAt: true },
  });
  let removed = 0;
  for (const clip of candidates) {
    const items = await prisma.orderItem.findMany({
      where: { orderId: clip.orderId, sellerId: clip.sellerId },
      select: { status: true, deliveredAt: true, return: { select: { status: true } } },
    });
    const expires = packingVideoExpiresAt(clip.uploadedAt, items);
    if (!expires || expires > now) continue;
    // One bad file never stops the rest of the sweep.
    await removeStoredFile(clip.fileRef).catch((err) =>
      console.error('[clowe-api] packing video not removed:', err instanceof Error ? err.message : err),
    );
    await prisma.orderPackingVideo.update({ where: { id: clip.id }, data: { deletedAt: now } });
    removed += 1;
  }
  return removed;
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
