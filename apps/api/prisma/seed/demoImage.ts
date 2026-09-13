// Demo/placeholder image helper shared by the seed scripts and
// `npm run db:localize-images`.
//
// Seeds generate picsum.photos / loremflickr.com URLs. Those hosts take
// 2-4 s per image, which made every catalog page crawl in development. The
// localize script downloads each placeholder once into <UPLOAD_DIR>/demo and
// rewrites the DB rows to a root-relative `/uploads/demo/<key>.<ext>` URL,
// which the browser resolves against the web origin (Next proxies /uploads
// to the API in dev; nginx does it in production).
//
// `demoImage(url)` returns that local URL when the file already exists, so a
// re-seed keeps using local images; otherwise it falls back to the external
// URL and the localize script can be run again.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const DEMO_IMAGE_EXTS = ['jpg', 'png', 'webp', 'gif'] as const;

/** Absolute path of <UPLOAD_DIR>/demo (UPLOAD_DIR is relative to apps/api). */
export const demoImageDir = path.resolve(process.env.UPLOAD_DIR ?? 'uploads', 'demo');

export function isPlaceholderUrl(url: string | null | undefined): url is string {
  return !!url && (url.startsWith('https://picsum.photos/') || url.startsWith('https://loremflickr.com/'));
}

/** Stable file key for an external URL. */
export function demoImageKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 20);
}

/** Local URL for an already-downloaded placeholder, or null if not on disk. */
export function localDemoImageUrl(url: string): string | null {
  const key = demoImageKey(url);
  for (const ext of DEMO_IMAGE_EXTS) {
    if (existsSync(path.join(demoImageDir, `${key}.${ext}`))) return `/uploads/demo/${key}.${ext}`;
  }
  return null;
}

/** Use in seeds: local copy when available, external placeholder otherwise. */
export function demoImage(url: string): string {
  return localDemoImageUrl(url) ?? url;
}
