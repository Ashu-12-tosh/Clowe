import type { PayoutProvider } from './PayoutProvider';
import { MockPayoutProvider } from './MockPayoutProvider';

/**
 * Only the mock exists today. A real payouts aggregator (RazorpayX, Cashfree)
 * drops in here once bank credentials are configured.
 */
function createPayoutProvider(): PayoutProvider {
  return new MockPayoutProvider();
}

export const payoutProvider = createPayoutProvider();
export type { PayoutProvider };
