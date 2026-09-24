import { createPublicKey } from 'node:crypto';
import { env } from '../../env';
import { pemFromEnv } from '../cashfree/client';
import { CashfreeKycProvider } from './CashfreeKycProvider';
import type { KycProvider } from './KycProvider';
import { MockKycProvider } from './MockKycProvider';

/**
 * Provider selection:
 * - KYC_PROVIDER=mock     → always the mock, even with keys set
 * - KYC_PROVIDER=cashfree → Cashfree; both verification keys are required
 * - KYC_PROVIDER=auto     → Cashfree when both keys are set, otherwise the mock.
 *   Adding the keys to the environment switches over with no code change.
 *
 * A malformed 2FA public key stops the server rather than falling back. The
 * fallback would be the mock, and the mock "verifies" everything — quietly
 * approving sellers on fake checks is worse than refusing to start.
 */
function createKycProvider(): KycProvider {
  const clientId = env.CASHFREE_VERIFICATION_CLIENT_ID;
  const clientSecret = env.CASHFREE_VERIFICATION_CLIENT_SECRET;
  const wantCashfree =
    env.KYC_PROVIDER === 'cashfree' || (env.KYC_PROVIDER === 'auto' && !!clientId && !!clientSecret);

  if (!wantCashfree) return new MockKycProvider();

  if (!clientId || !clientSecret) {
    throw new Error(
      'KYC_PROVIDER=cashfree requires CASHFREE_VERIFICATION_CLIENT_ID and CASHFREE_VERIFICATION_CLIENT_SECRET',
    );
  }
  let publicKeyPem: string | undefined;
  if (env.CASHFREE_VERIFICATION_PUBLIC_KEY) {
    publicKeyPem = pemFromEnv(env.CASHFREE_VERIFICATION_PUBLIC_KEY);
    try {
      createPublicKey(publicKeyPem);
    } catch {
      throw new Error('CASHFREE_VERIFICATION_PUBLIC_KEY is not a readable PEM public key');
    }
  }
  return new CashfreeKycProvider({
    clientId,
    clientSecret,
    environment: env.CASHFREE_VERIFICATION_ENV,
    publicKeyPem,
  });
}

export const kycProvider = createKycProvider();

/** Say which provider is live. No probe call: every Cashfree call is billed. */
export function logKycProviderStatus(): void {
  const halfConfigured =
    !!env.CASHFREE_VERIFICATION_CLIENT_ID !== !!env.CASHFREE_VERIFICATION_CLIENT_SECRET;
  if (halfConfigured) {
    console.warn(
      '[clowe-api] KYC: only one of CASHFREE_VERIFICATION_CLIENT_ID / _SECRET is set — using the mock',
    );
  }
  if (kycProvider.name === 'cashfree') {
    const twoFa = env.CASHFREE_VERIFICATION_PUBLIC_KEY ? 'signature 2FA' : 'IP allowlist 2FA';
    console.log(`[clowe-api] KYC: Cashfree Verification (${env.CASHFREE_VERIFICATION_ENV}, ${twoFa})`);
    return;
  }
  const line = '[clowe-api] KYC: mock provider — checks are not real (set the Cashfree verification keys)';
  if (env.NODE_ENV === 'production') console.warn(line);
  else console.log(line);
}

export { KycProviderError } from './KycProvider';
export type { KycProvider, KycResult, NameMatch } from './KycProvider';
