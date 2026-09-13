import { env } from '../../env';
import type { TryOnProvider } from './TryOnProvider';
import { MockTryOnProvider } from './MockTryOnProvider';
import { FashnTryOnProvider } from './FashnTryOnProvider';

/**
 * Provider selection:
 * - TRYON_PROVIDER=mock   → always mock (even with a key)
 * - TRYON_PROVIDER=fashn  → FASHN (requires FASHN_API_KEY)
 * - TRYON_PROVIDER=auto   → FASHN when FASHN_API_KEY is set, else mock.
 *   So adding the key to .env later switches to real try-on with zero code changes.
 */
function createTryOnProvider(): TryOnProvider {
  const wantFashn =
    env.TRYON_PROVIDER === 'fashn' || (env.TRYON_PROVIDER === 'auto' && !!env.FASHN_API_KEY);

  if (wantFashn) {
    if (!env.FASHN_API_KEY) {
      throw new Error('TRYON_PROVIDER=fashn requires FASHN_API_KEY');
    }
    return new FashnTryOnProvider(env.FASHN_API_KEY, env.TRYON_COST_PAISE);
  }
  return new MockTryOnProvider();
}

export const tryOnProvider = createTryOnProvider();

/**
 * Say which provider is live, and — for FASHN — check the key actually works.
 *
 * A wrong key would otherwise only surface as a failed try-on for a real
 * shopper, so it is worth one cheap unbilled request at boot. Never throws:
 * try-on is one feature, not a reason to refuse to start.
 */
export async function logTryOnProviderStatus(): Promise<void> {
  if (tryOnProvider.name !== 'fashn') {
    console.log(
      '[clowe-api] AI Try-On: mock provider (set FASHN_API_KEY in .env for real try-on)',
    );
    return;
  }
  console.log(`[clowe-api] AI Try-On: FASHN (${env.FASHN_MODEL}, mode=${env.FASHN_MODE})`);
  const check = await tryOnProvider.verifyCredentials?.();
  if (check && !check.ok) {
    console.error(`[clowe-api] AI Try-On: ${check.detail} — try-ons will fail until this is fixed`);
  }
}

export { garmentCategoryFor } from './garmentCategory';
export { isSensitiveForTryOn } from './sensitiveGarment';
export {
  TRYON_MIN_AGE_YEARS,
  isListingBelowTryOnAge,
  isSizeBelowTryOnAge,
} from './ageGate';
export { TryOnError } from './TryOnProvider';
export type { TryOnProvider };
