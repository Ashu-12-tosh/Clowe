import { randomBytes } from 'node:crypto';
import type { AssetPurpose } from '@prisma/client';
import { assetIdOf, assetRef } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { privateStorage, storageFor } from './storage';

// ---------------------------------------------------------------------------
// Private files: stored once, referred to as "asset:<id>", shown through
// short-lived signed URLs.
//
// Rows hold a reference, never a URL. An endpoint that has already decided the
// viewer may see a row turns its references into signed URLs on the way out
// (resolveFileUrls), so a URL in a browser stops working within minutes, and
// attaching a reference to anything requires having uploaded it
// (assertOwnAssets).
//
// Values that are not references pass through untouched: the seeded demo
// rows point at stock-photo hosts, and those go with the demo catalog.
// ---------------------------------------------------------------------------

export const IMAGE_URL_TTL_SECONDS = 5 * 60;
/** Longer for video: playback keeps requesting ranges of the same URL. */
export const VIDEO_URL_TTL_SECONDS = 15 * 60;

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export function extensionFor(contentType: string): string | null {
  return EXTENSION[contentType] ?? null;
}

function keyFor(purpose: AssetPurpose, ext: string): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  // Unguessable, and says nothing about who or what it is.
  return `${purpose.toLowerCase().replace(/_/g, '-')}/${now.getUTCFullYear()}/${month}/${randomBytes(16).toString('hex')}.${ext}`;
}

export async function storePrivateFile(input: {
  purpose: AssetPurpose;
  ownerId: string | null;
  body: Buffer;
  contentType: string;
}): Promise<{ id: string; ref: string }> {
  const ext = extensionFor(input.contentType);
  if (!ext) throw new Error(`Unsupported content type ${input.contentType}`);
  const key = keyFor(input.purpose, ext);
  await privateStorage.put(key, input.body, input.contentType);
  try {
    const asset = await prisma.asset.create({
      data: {
        provider: privateStorage.name,
        key,
        purpose: input.purpose,
        contentType: input.contentType,
        bytes: input.body.length,
        ownerId: input.ownerId,
      },
    });
    return { id: asset.id, ref: assetRef(asset.id) };
  } catch (err) {
    // No row, no file: never leave bytes nothing refers to.
    await privateStorage.delete(key).catch(() => {});
    throw err;
  }
}

/**
 * URLs a browser can load, in the same order. References become signed URLs
 * (null once the file is gone); anything else is returned as it is. Call it
 * only after deciding the viewer may see these files.
 */
export async function resolveFileUrls(values: (string | null | undefined)[]): Promise<(string | null)[]> {
  const ids = values.map(assetIdOf).filter((id): id is string => id !== null);
  const assets = ids.length
    ? await prisma.asset.findMany({ where: { id: { in: ids } }, select: { id: true, provider: true, key: true, contentType: true, deletedAt: true } })
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  return Promise.all(
    values.map(async (value) => {
      const id = assetIdOf(value);
      if (id === null) return value ?? null;
      const asset = byId.get(id);
      if (!asset || asset.deletedAt) return null;
      const ttl = asset.contentType.startsWith('video/') ? VIDEO_URL_TTL_SECONDS : IMAGE_URL_TTL_SECONDS;
      try {
        return await storageFor(asset.provider).signedUrl(asset.key, ttl);
      } catch (err) {
        // A file whose store is not configured shows as missing; the page still loads.
        console.error(`[clowe-api] no URL for asset ${asset.id}:`, err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
}

export async function resolveFileUrl(value: string | null | undefined): Promise<string | null> {
  return (await resolveFileUrls([value]))[0];
}

/** Rows with their photo references swapped for URLs, in one lookup; photos that are gone are dropped. */
export async function withPhotoUrls<T extends { photos: string[] }>(rows: T[]): Promise<T[]> {
  const urls = await resolveFileUrls(rows.flatMap((r) => r.photos));
  let next = 0;
  return rows.map((r) => ({
    ...r,
    photos: r.photos.map(() => urls[next++]).filter((u): u is string => u !== null),
  }));
}

/** The bytes behind a reference, for the server's own use (try-on). Null if it is not a reference. */
export async function readFileRef(value: string): Promise<Buffer | null> {
  const id = assetIdOf(value);
  if (id === null) return null;
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset || asset.deletedAt) throw new Error('That file is no longer available');
  return storageFor(asset.provider).get(asset.key);
}

/**
 * Refuse unless every reference is a live file this user uploaded for this
 * purpose. Stops a request from attaching someone else's photo by its id.
 */
export async function assertOwnAssets(refs: string[], owner: { ownerId: string; purpose: AssetPurpose }): Promise<void> {
  const ids = refs.map(assetIdOf);
  const refuse = () => {
    throw ApiError.badRequest('Upload the file again and retry', 'INVALID_FILE');
  };
  if (ids.some((id) => id === null)) refuse();
  const unique = [...new Set(ids as string[])];
  const assets = await prisma.asset.findMany({
    where: { id: { in: unique }, ownerId: owner.ownerId, purpose: owner.purpose, deletedAt: null },
    select: { id: true },
  });
  if (assets.length !== unique.length) refuse();
}

/** Delete the bytes behind a reference and mark it gone. False if the value is not a reference. */
export async function deleteFileRef(value: string): Promise<boolean> {
  const id = assetIdOf(value);
  if (id === null) return false;
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset || asset.deletedAt) return true;
  await storageFor(asset.provider).delete(asset.key);
  await prisma.asset.update({ where: { id }, data: { deletedAt: new Date() } });
  return true;
}

