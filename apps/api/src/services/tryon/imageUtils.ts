import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../env';
import { uploadDir } from '../../routes/uploads';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Fetch an image as a base64 data URI. URLs under our own /uploads are read
 * straight from disk (external services can't reach localhost); anything else
 * is fetched over HTTP.
 */
export async function imageUrlToDataUri(url: string): Promise<string> {
  const uploadsPrefix = `${env.API_PUBLIC_URL}/uploads/`;
  if (url.startsWith(uploadsPrefix)) {
    const filename = path.basename(url.slice(uploadsPrefix.length));
    const filePath = path.join(uploadDir, filename);
    const buf = await fs.readFile(filePath);
    const mime = MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not fetch image (${res.status}): ${url}`);
  const mime = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString('base64')}`;
}
