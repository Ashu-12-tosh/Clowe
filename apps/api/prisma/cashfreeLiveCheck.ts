/**
 * Read-only check of the Cashfree production keys, from the server (whose IP
 * is the one Cashfree allowlisted):
 *
 *   dc exec api npx tsx prisma/cashfreeLiveCheck.ts
 *
 *   Payouts    authorize + get balance (v1). Moves no money.
 *   Secure ID  asks the status of a bank verification that cannot exist
 *              (reference_id 0): nothing is verified, no PAN, GSTIN or account
 *              is sent. A 401/403 means the keys or the IP are refused.
 *
 * Prints which provider is live, the balance and HTTP statuses — never a key.
 * Writes nothing to the database.
 */
import { env } from '../src/env';
import { cashfreePayoutAccount, payoutProvider } from '../src/services/payouts';
import { kycProvider } from '../src/services/kyc';
import { CashfreeKycProvider } from '../src/services/kyc/CashfreeKycProvider';
import { pemFromEnv } from '../src/services/cashfree/client';
import { reviewMode } from '../src/services/kyc/sellerKyc';

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

async function main() {
  let failed = false;
  console.log(`Payouts: sending through ${payoutProvider.name}; Cashfree Payouts env ${env.CASHFREE_PAYOUT_ENV}`);
  const payouts = cashfreePayoutAccount();
  if (!payouts) {
    console.log('  Payouts keys: not set — skipped');
  } else {
    try {
      const b = await payouts.getBalance();
      console.log(`  Payouts auth: OK; balance ${rupees(b.balancePaise)}, available ${rupees(b.availablePaise)}`);
    } catch (err) {
      failed = true;
      console.log(`  Payouts auth/balance: FAILED — ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  console.log(`Secure ID: KYC provider ${kycProvider.name} (${reviewMode()} review); env ${env.CASHFREE_VERIFICATION_ENV}`);
  if (!env.CASHFREE_VERIFICATION_CLIENT_ID || !env.CASHFREE_VERIFICATION_CLIENT_SECRET) {
    console.log('  Secure ID keys: not set — skipped');
  } else {
    const kyc = new CashfreeKycProvider({
      clientId: env.CASHFREE_VERIFICATION_CLIENT_ID,
      clientSecret: env.CASHFREE_VERIFICATION_CLIENT_SECRET,
      environment: env.CASHFREE_VERIFICATION_ENV,
      publicKeyPem: env.CASHFREE_VERIFICATION_PUBLIC_KEY ? pemFromEnv(env.CASHFREE_VERIFICATION_PUBLIC_KEY) : undefined,
    });
    const r = await kyc.checkAuth();
    if (!r.ok) failed = true;
    console.log(`  Secure ID auth: ${r.ok ? 'OK' : 'FAILED'} (status lookup of a non-existent reference: HTTP ${r.status}${r.code ? ` ${r.code}` : ''}; nothing verified)`);
  }
  process.exit(failed ? 1 : 0);
}

void main();
