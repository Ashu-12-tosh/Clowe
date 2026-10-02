import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../env';
import { STORAGE_KEY, type StorageProvider } from './StorageProvider';

/**
 * Private files on local disk, under PRIVATE_UPLOAD_DIR — a folder nothing
 * serves statically. A browser reaches a file only through
 * /api/files/local with a signature over the key and an expiry, the same
 * model as an S3 presigned URL, so swapping providers changes nothing above.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;
  readonly root: string;

  constructor(root = path.resolve(env.PRIVATE_UPLOAD_DIR)) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  /** The file's absolute path, refusing anything that is not a well-formed key inside the root. */
  pathFor(key: string): string {
    if (!STORAGE_KEY.test(key)) throw new Error(`Bad storage key: ${key}`);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Bad storage key: ${key}`);
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      await fs.access(this.root, fs.constants.W_OK);
      return { ok: true, detail: 'Private file folder writable' };
    } catch {
      return { ok: false, detail: 'Private file folder is not writable' };
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const query = new URLSearchParams({ k: key, e: String(expires), s: signLocalFile(key, expires) });
    return `${env.API_PUBLIC_URL}/api/files/local?${query.toString()}`;
  }
}

function secret(): string {
  return env.FILE_URL_SECRET ?? env.JWT_ACCESS_SECRET;
}

export function signLocalFile(key: string, expires: number): string {
  return createHmac('sha256', secret()).update(`${key}\n${expires}`).digest('base64url');
}

/** Whether a signed local-file URL's parameters are genuine and unexpired. */
export function verifyLocalFile(key: unknown, expires: unknown, signature: unknown): boolean {
  if (typeof key !== 'string' || typeof expires !== 'string' || typeof signature !== 'string') return false;
  if (!STORAGE_KEY.test(key) || !/^\d{1,12}$/.test(expires)) return false;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signLocalFile(key, Number(expires)));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
