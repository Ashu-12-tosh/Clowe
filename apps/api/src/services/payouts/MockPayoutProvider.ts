import { randomInt } from 'node:crypto';
import type {
  PayoutProvider,
  PayoutTransfer,
  PayoutTransferRequest,
  PayoutVerification,
} from './PayoutProvider';

/**
 * Dev provider: settles instantly with a plausible UTR and no external calls,
 * so the whole payout flow (request → settle → statement) is testable free.
 */
export class MockPayoutProvider implements PayoutProvider {
  readonly name = 'mock';

  async transfer(request: PayoutTransferRequest): Promise<PayoutTransfer> {
    if (request.amountPaise <= 0) {
      return { utr: '', status: 'FAILED', failureReason: 'Nothing to transfer' };
    }
    return {
      utr: `UTR${Date.now().toString().slice(-9)}${randomInt(1000, 9999)}`,
      status: 'PAID',
    };
  }

  async verifyMethod(input: {
    accountLast4?: string | null;
    ifsc?: string | null;
    upiId?: string | null;
  }): Promise<PayoutVerification> {
    if (input.upiId) return { verified: true };
    if (input.accountLast4 && input.ifsc) return { verified: true };
    return { verified: false, reason: 'Account number and IFSC are required' };
  }
}
