import { createPublicKey } from 'node:crypto';
import { env } from '../../env';
import { pemFromEnv } from '../cashfree/client';
import type { PayoutProvider } from './PayoutProvider';
import { MockPayoutProvider } from './MockPayoutProvider';
import { CashfreePayoutProvider } from './CashfreePayoutProvider';

/**
 * PAYOUT_PROVIDER=mock (the default) settles instantly with a fake UTR;
 * cashfree sends real transfers through Cashfree Payouts. A malformed 2FA key
 * stops the server rather than falling back to the mock.
 */
function createPayoutProvider(): PayoutProvider {
  if (env.PAYOUT_PROVIDER !== 'cashfree') return new MockPayoutProvider();
  if (!env.CASHFREE_PAYOUT_CLIENT_ID || !env.CASHFREE_PAYOUT_CLIENT_SECRET) {
    throw new Error('PAYOUT_PROVIDER=cashfree requires CASHFREE_PAYOUT_CLIENT_ID and CASHFREE_PAYOUT_CLIENT_SECRET');
  }
  let publicKeyPem: string | undefined;
  if (env.CASHFREE_PAYOUT_PUBLIC_KEY) {
    publicKeyPem = pemFromEnv(env.CASHFREE_PAYOUT_PUBLIC_KEY);
    try {
      createPublicKey(publicKeyPem);
    } catch {
      throw new Error('CASHFREE_PAYOUT_PUBLIC_KEY is not a readable PEM public key');
    }
  }
  return new CashfreePayoutProvider({
    clientId: env.CASHFREE_PAYOUT_CLIENT_ID,
    clientSecret: env.CASHFREE_PAYOUT_CLIENT_SECRET,
    environment: env.CASHFREE_PAYOUT_ENV,
    publicKeyPem,
  });
}

/**
 * The Cashfree Payouts account itself, whenever its keys are set — even while
 * PAYOUT_PROVIDER is still the mock — for the read-only things: the balance on
 * the admin's payouts page and the live check. Never used to send money:
 * transfers go only through `payoutProvider`.
 */
export function cashfreePayoutAccount(): CashfreePayoutProvider | null {
  if (payoutProvider instanceof CashfreePayoutProvider) return payoutProvider;
  if (!env.CASHFREE_PAYOUT_CLIENT_ID || !env.CASHFREE_PAYOUT_CLIENT_SECRET) return null;
  return new CashfreePayoutProvider({
    clientId: env.CASHFREE_PAYOUT_CLIENT_ID,
    clientSecret: env.CASHFREE_PAYOUT_CLIENT_SECRET,
    environment: env.CASHFREE_PAYOUT_ENV,
    publicKeyPem: env.CASHFREE_PAYOUT_PUBLIC_KEY ? pemFromEnv(env.CASHFREE_PAYOUT_PUBLIC_KEY) : undefined,
  });
}

/** `let` only so a test can stand a fake Cashfree in; nothing else reassigns it. */
export let payoutProvider: PayoutProvider = createPayoutProvider();

/** Tests only: swap the payout provider, and put it back. */
export function setPayoutProviderForTests(provider: PayoutProvider): () => void {
  if (env.NODE_ENV !== 'test') throw new Error('setPayoutProviderForTests is for tests only');
  const previous = payoutProvider;
  payoutProvider = provider;
  return () => {
    payoutProvider = previous;
  };
}

export function logPayoutProviderStatus(): void {
  if (payoutProvider.name === 'cashfree') {
    const twoFa = env.CASHFREE_PAYOUT_PUBLIC_KEY ? 'signature 2FA' : 'IP allowlist 2FA, IPv4';
    console.log(`[clowe-api] Payouts: Cashfree (${env.CASHFREE_PAYOUT_ENV}, ${twoFa})`);
    return;
  }
  const line = '[clowe-api] Payouts: mock — no real transfers';
  if (env.NODE_ENV === 'production') console.warn(line);
  else console.log(line);
}

export type { PayoutProvider };
