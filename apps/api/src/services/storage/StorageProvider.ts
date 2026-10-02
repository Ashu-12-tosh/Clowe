/**
 * Where private files live. Only private files go through this: public
 * catalog images are still served from the public uploads folder until the
 * image CDN replaces it.
 *
 * Implementations: LocalStorageProvider (disk; the dev default and the
 * fallback whenever no cloud store is configured). Keys are chosen by
 * services/assets.ts and are plain paths: lowercase, digits, dashes and
 * slashes, ending in an extension.
 */
export interface StorageProvider {
  readonly name: 'local';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting a key that is not there is not an error. */
  delete(key: string): Promise<void>;
  /** A URL a browser can load for `ttlSeconds`, and not after. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Whether files can be written right now, for health checks. */
  check(): Promise<{ ok: boolean; detail: string }>;
}

export const STORAGE_KEY = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.[a-z0-9]+$/;
