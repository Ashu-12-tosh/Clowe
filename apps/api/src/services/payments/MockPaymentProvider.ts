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

  verifySignature(): boolean {
    return true; // mock payments settle via /api/payments/mock-pay instead
  }

  async refund(_input: GatewayRefundInput): Promise<GatewayRefund> {
    return { providerRefundId: `mock_refund_${randomBytes(8).toString('hex')}`, status: 'SUCCESS', providerStatus: 'SUCCESS' };
  }
}
