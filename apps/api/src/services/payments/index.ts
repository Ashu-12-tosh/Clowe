import { env } from '../../env';
import type { PaymentProvider } from './PaymentProvider';
import { MockPaymentProvider } from './MockPaymentProvider';
import { RazorpayProvider } from './RazorpayProvider';

function createPaymentProvider(): PaymentProvider {
  if (env.PAYMENT_PROVIDER === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new Error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    }
    return new RazorpayProvider(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  }
  return new MockPaymentProvider();
}

export const paymentProvider = createPaymentProvider();
export { RazorpayProvider };
export type { PaymentProvider };
