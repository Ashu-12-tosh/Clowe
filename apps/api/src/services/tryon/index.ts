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
export type { TryOnProvider };
