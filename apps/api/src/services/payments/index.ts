import { env } from '../../env';
import type { GatewayName, PaymentProvider } from './PaymentProvider';
import { MockPaymentProvider } from './MockPaymentProvider';
import { RazorpayProvider } from './RazorpayProvider';
import { CashfreePaymentProvider } from './CashfreePaymentProvider';

function createPaymentProvider(): PaymentProvider {
  if (env.PAYMENT_PROVIDER === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new Error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    }
    return new RazorpayProvider(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  }
  if (env.PAYMENT_PROVIDER === 'cashfree') {
    // env.ts has already refused a missing key; this keeps the types honest.
    if (!env.CASHFREE_PG_CLIENT_ID || !env.CASHFREE_PG_CLIENT_SECRET) {
      throw new Error('PAYMENT_PROVIDER=cashfree requires CASHFREE_PG_CLIENT_ID and CASHFREE_PG_CLIENT_SECRET');
    }
    return new CashfreePaymentProvider({
      clientId: env.CASHFREE_PG_CLIENT_ID,
      clientSecret: env.CASHFREE_PG_CLIENT_SECRET,
      environment: env.CASHFREE_PG_ENV,
    });
  }
  return new MockPaymentProvider();
}

/**
 * The gateway new payments are made through. `let` only so a test can stand a
 * fake Cashfree in (setPaymentProviderForTests); nothing else reassigns it.
 */
export let paymentProvider: PaymentProvider = createPaymentProvider();

/**
 * The gateway a recorded payment was made through. A refund or a status check
 * must go to the gateway that took the money, which is the active one unless
 * PAYMENT_PROVIDER changed since — then there is no client for it here, and
 * the caller records why rather than asking the wrong gateway.
 */
export function providerFor(name: string): PaymentProvider | null {
  if (name === paymentProvider.name) return paymentProvider;
  if (name === 'mock' && env.NODE_ENV !== 'production') return new MockPaymentProvider();
  return null;
}

export function isGatewayName(name: string): name is GatewayName {
  return name === 'mock' || name === 'razorpay' || name === 'cashfree';
}

/** Tests only: swap the active gateway, and put it back. */
export function setPaymentProviderForTests(provider: PaymentProvider): () => void {
  if (env.NODE_ENV !== 'test') throw new Error('setPaymentProviderForTests is for tests only');
  const previous = paymentProvider;
  paymentProvider = provider;
  return () => {
    paymentProvider = previous;
  };
}

/** Say which gateway is live, at boot. No probe call. */
export function logPaymentProviderStatus(): void {
  if (paymentProvider.name === 'cashfree') {
    console.log(`[clowe-api] Payments: Cashfree (${env.CASHFREE_PG_ENV})`);
    return;
  }
  const line = `[clowe-api] Payments: ${paymentProvider.name}${paymentProvider.name === 'mock' ? ' — no real money is taken' : ''}`;
  if (env.NODE_ENV === 'production' && paymentProvider.name === 'mock') console.warn(line);
  else console.log(line);
}

export { RazorpayProvider, CashfreePaymentProvider };
export { GatewayError } from './PaymentProvider';
export type { PaymentProvider };
