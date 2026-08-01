import { randomBytes } from 'node:crypto';
import type { PaymentProvider } from './PaymentProvider';

/**
 * Dev-only gateway: no external calls. The checkout page shows a fake
 * "Pay" button which hits /api/payments/mock-pay to settle the payment.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async createOrder(_amountPaise: number, _receipt: string): Promise<string> {
    return `mock_order_${randomBytes(8).toString('hex')}`;
  }

  verifySignature(): boolean {
    return true; // mock payments settle via /api/payments/mock-pay instead
  }

  async refund(_providerPaymentId: string, _amountPaise: number): Promise<string> {
    return `mock_refund_${randomBytes(8).toString('hex')}`;
  }
}
