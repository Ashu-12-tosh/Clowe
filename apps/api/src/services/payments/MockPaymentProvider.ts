import { randomBytes } from 'node:crypto';
import type { CreateGatewayOrderInput, GatewayOrder, GatewayRefund, GatewayRefundInput, PaymentProvider } from './PaymentProvider';

/**
 * Dev-only gateway: no external calls. The checkout page shows a fake
 * "Pay" button which hits /api/payments/mock-pay to settle the payment.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async createOrder(_input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    return { providerOrderId: `mock_order_${randomBytes(8).toString('hex')}` };
  }

  /**
   * Never: the mock has no signatures to check. Its payments settle only via
   * /mock-pay, which refuses on production for anyone but admins and test
   * accounts. Answering true here let /verify mark any order paid.
   */
  verifySignature(): boolean {
    return false;
  }

  async refund(_input: GatewayRefundInput): Promise<GatewayRefund> {
    return { providerRefundId: `mock_refund_${randomBytes(8).toString('hex')}`, status: 'SUCCESS', providerStatus: 'SUCCESS' };
  }
}
