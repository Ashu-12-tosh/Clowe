import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../../env';
import { uploadDir } from '../../routes/uploads';
import { fetchPublic } from '../../utils/publicFetch';
import { readFileRef } from '../assets';

/**
 * FASHN processes try-on images at 864 x 1296. Sending anything larger just
 * costs upload time on both hops, so images are fitted into that box before
 * they leave us.
 */
const TARGET_WIDTH = 864;
const TARGET_HEIGHT = 1296;
const JPEG_QUALITY = 90;

/** Guard against a hostile or mistyped URL streaming gigabytes into memory. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Read an image we host ourselves, or fetch a remote one.
 *
 * Our own uploads may be referenced absolutely (`${API_PUBLIC_URL}/uploads/x`)
 * or root-relative (`/uploads/demo/x`, as the seeded demo catalog does). Both
 * are read from disk — no HTTP round trip, and it works on localhost where an
 * external service could never reach us. Sub-folders are kept; escaping the
 * uploads directory is not.
 */
async function loadImageBytes(url: string): Promise<Buffer> {
  // A private upload (the shopper's photo), read straight from storage.
  const privateFile = await readFileRef(url);
  if (privateFile) return privateFile;

  const uploadsPrefix = `${env.API_PUBLIC_URL}/uploads/`;
  const relative = url.startsWith(uploadsPrefix)
    ? url.slice(uploadsPrefix.length)
    : url.startsWith('/uploads/')
      ? url.slice('/uploads/'.length)
      : null;

  if (relative !== null) {
    const filePath = path.resolve(uploadDir, path.normalize(relative.split('?')[0]));
    if (!filePath.startsWith(uploadDir + path.sep)) {
      throw new Error(`Refusing to read outside the uploads directory: ${url}`);
    }
    return fs.readFile(filePath);
  }

  // Anywhere else is fetched from the public internet only: product images
  // are seller-supplied URLs, and must not be a way to reach inside.
  return fetchPublic(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_SOURCE_BYTES });
}

/**
 * Normalise an image for the try-on model and return it as a base64 data URI.
 *
 * `rotate()` with no argument applies the EXIF orientation and then drops it —
 * without this, a photo taken on a phone reaches the model lying on its side.
 * Re-encoding also strips EXIF wholesale, so GPS coordinates and camera serial
 * numbers in a shopper's photo never leave this server.
 */
export async function imageUrlToDataUri(url: string): Promise<string> {
  const source = await loadImageBytes(url);
  const jpeg = await sharp(source, { failOn: 'none' })
    .rotate()
    .resize({
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' }) // PNG/WebP transparency -> white, not black
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}
