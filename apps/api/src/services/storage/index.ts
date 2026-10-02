import { env } from '../../env';
import { LocalStorageProvider } from './LocalStorageProvider';
import type { StorageProvider } from './StorageProvider';

/**
 * Provider selection for private files:
 * - STORAGE_PROVIDER=local → disk under PRIVATE_UPLOAD_DIR
 * - STORAGE_PROVIDER=auto  → the best configured provider; local until a
 *   cloud store is configured, so a missing key never breaks anything.
 *
 * Every provider that may hold existing files is constructed, and an asset is
 * always read from the provider recorded on its row, so switching providers
 * leaves older files readable.
 */
export const localFiles = new LocalStorageProvider();

const providers: Record<string, StorageProvider> = { local: localFiles };

function choose(): StorageProvider {
  void env.STORAGE_PROVIDER; // 'auto' and 'local' both mean local while no cloud provider exists
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

export function logStorageStatus(): void {
  console.log(`[clowe-api] private files: ${privateStorage.name} (${localFiles.root})`);
}

export type { StorageProvider };
