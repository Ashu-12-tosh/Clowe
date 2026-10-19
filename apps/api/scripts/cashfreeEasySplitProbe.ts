/**
 * SANDBOX ONLY: is Easy Split usable on this Cashfree sandbox account?
 *
 *   npx tsx scripts/cashfreeEasySplitProbe.ts vendor   → create (or read) one test vendor, print its status
 *   npx tsx scripts/cashfreeEasySplitProbe.ts order    → a ₹100 order with ₹80 split to it; prints the session to pay
 *   npx tsx scripts/cashfreeEasySplitProbe.ts shares <orderId> → the order's vendor shares and eligibility dates
 *   npx tsx scripts/cashfreeEasySplitProbe.ts release <orderId> → bring the vendor's settlement forward to now
 *
 * Refuses to run outside sandbox.
 */
import { env } from '../src/env';
import { CashfreeEasySplitClient } from '../src/services/cashfree/easySplitClient';
import { CashfreePaymentProvider } from '../src/services/payments/CashfreePaymentProvider';

if (env.NODE_ENV === 'production' || env.CASHFREE_PG_ENV !== 'sandbox' || !env.CASHFREE_PG_CLIENT_ID || !env.CASHFREE_PG_CLIENT_SECRET) {
  throw new Error('Sandbox only — refusing to run');
}
const keys = { clientId: env.CASHFREE_PG_CLIENT_ID, clientSecret: env.CASHFREE_PG_CLIENT_SECRET, environment: 'sandbox' as const };
const client = new CashfreeEasySplitClient(keys);
const VENDOR = 'CLW_sandbox_probe_2';

async function main(cmd: string | undefined, arg: string | undefined) {
  if (cmd === 'vendor') {
    try {
      return { vendor: VENDOR, status: await client.vendorStatus(VENDOR) };
    } catch {
      return {
        vendor: VENDOR,
        status: await client.createVendor({
          vendorId: VENDOR,
          // Cashfree's Easy Split sandbox test data (a success account and a business PAN).
          name: 'John Doe',
          email: 'probe.vendor@example.com',
          phone: '9876543210',
          bank: { accountNumber: '00011020001772', accountHolder: 'John Doe', ifsc: 'HDFC0000001' },
          pan: 'ABCCD8000T',
          accountType: 'BUSINESS',
          businessType: 'E-commerce',
        }),
      };
    }
  }
  if (cmd === 'order') {
    const receipt = `CLW-SPLIT-${Date.now().toString(36).toUpperCase()}`;
    const order = await new CashfreePaymentProvider(keys).createOrder({
      amountPaise: 10_000,
      receipt,
      customer: { id: 'sandboxprobe', phone: '9871000001', name: 'Sandbox Probe' },
      splits: [{ vendorId: VENDOR, amountPaise: 8_000 }],
    });
    return { orderId: order.providerOrderId, session: order.paymentSessionId };
  }
  if (cmd === 'shares') return { shares: await client.orderShares(arg!) };
  if (cmd === 'release') {
    await client.release(arg!, VENDOR, new Date());
    return { released: arg, shares: await client.orderShares(arg!) };
  }
  throw new Error('usage: vendor | order | shares <orderId> | release <orderId>');
}

main(process.argv[2], process.argv[3])
  .then((r) => console.log(JSON.stringify(r)))
  .catch((err) => console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })));
