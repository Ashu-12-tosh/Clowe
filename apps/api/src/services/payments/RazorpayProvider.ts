import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentProvider } from './PaymentProvider';

/**
 * Razorpay via its REST API (no SDK needed). Test mode works with
 * rzp_test_* keys. https://razorpay.com/docs/api/orders/
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
  ) {}

  get publicKeyId(): string {
    return this.keyId;
  }

  async createOrder(amountPaise: number, receipt: string): Promise<string> {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Razorpay order creation failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  /** Standard Razorpay checkout signature: HMAC-SHA256(orderId|paymentId, keySecret). */
  verifySignature(providerOrderId: string, paymentId: string, signature: string): boolean {
    const expected = createHmac('sha256', this.keySecret)
      .update(`${providerOrderId}|${paymentId}`)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Webhook signature: HMAC-SHA256(rawBody, webhookSecret). */
  static verifyWebhook(rawBody: Buffer, signature: string, webhookSecret: string): boolean {
    const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
