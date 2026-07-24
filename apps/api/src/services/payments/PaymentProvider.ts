/**
 * Provider-agnostic payment gateway interface.
 * Implementations: MockPaymentProvider (dev), RazorpayProvider (test/live).
 */
export interface PaymentProvider {
  readonly name: 'mock' | 'razorpay';
  /** Public key id for frontend checkout widgets (Razorpay); undefined for mock. */
  readonly publicKeyId?: string;
  /** Create a gateway-side order; returns the provider's order id. */
  createOrder(amountPaise: number, receipt: string): Promise<string>;
  /** Verify a client-side payment callback signature. */
  verifySignature(providerOrderId: string, paymentId: string, signature: string): boolean;
}
