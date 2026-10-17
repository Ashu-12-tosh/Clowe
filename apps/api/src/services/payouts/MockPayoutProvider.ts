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

  /**
   * The mock never verifies an account — in any environment. A payout account
   * is verified by an admin against the cancelled cheque (the bank account in
   * Store Settings), or by a real provider's penny drop.
   */
  async verifyMethod(input: {
    accountLast4?: string | null;
    ifsc?: string | null;
    upiId?: string | null;
  }): Promise<PayoutVerification> {
    if (!input.upiId && !(input.accountLast4 && input.ifsc)) return { verified: false, reason: 'Account number and IFSC are required' };
    return { verified: false, reason: 'Waiting for Clowe to verify it' };
  }
}
