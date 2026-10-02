import { env } from '../../env';
import { LocalStorageProvider } from './LocalStorageProvider';
import { R2StorageProvider } from './R2StorageProvider';
import type { StorageProvider } from './StorageProvider';

/**
 * Provider selection for private files:
 * - STORAGE_PROVIDER=local → disk under PRIVATE_UPLOAD_DIR
 * - STORAGE_PROVIDER=r2    → Cloudflare R2 (requires the four R2_* settings)
 * - STORAGE_PROVIDER=auto  → R2 when all four R2_* settings are present,
 *   else local. So adding the keys switches new uploads to R2 with no code
 *   change, and a missing key never breaks anything.
 *
 * Every provider that may hold existing files is constructed, and an asset is
 * always read from the provider recorded on its row, so switching providers
 * leaves older files readable (prisma/moveAssets.ts moves them across).
 */
export const localFiles = new LocalStorageProvider();

function r2FromEnv(): R2StorageProvider | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PRIVATE_BUCKET, R2_ENDPOINT } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PRIVATE_BUCKET) return null;
  return new R2StorageProvider({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_PRIVATE_BUCKET,
    endpoint: R2_ENDPOINT,
  });
}

export const r2Files = r2FromEnv();

const providers: Record<string, StorageProvider> = {
  local: localFiles,
  ...(r2Files ? { r2: r2Files } : {}),
};

function choose(): StorageProvider {
  if (env.STORAGE_PROVIDER === 'r2') {
    if (!r2Files) {
      throw new Error('STORAGE_PROVIDER=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PRIVATE_BUCKET');
    }
    return r2Files;
  }
  if (env.STORAGE_PROVIDER === 'auto' && r2Files) return r2Files;
  return localFiles;
}

/** Where new private files are written. */
export const privateStorage = choose();

/** The provider an existing asset lives in. */
export function storageFor(name: string): StorageProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`No storage provider "${name}" is configured`);
  return provider;
}

/** Say where private files go, and — for R2 — whether the bucket answers. Never throws. */
export async function logStorageStatus(): Promise<void> {
  if (privateStorage.name === 'local') {
    console.log(`[clowe-api] private files: local disk (${localFiles.root}) - set the R2_* keys to use R2`);
    return;
  }
  const check = await privateStorage.check();
  console.log(`[clowe-api] private files: R2 - ${check.detail}`);
}

export type { StorageProvider };
