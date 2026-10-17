import { prisma } from '../db';
import { encryptBankAccount } from '../services/bankAccountCrypto';
import { reviewSellerKyc } from '../services/kyc/sellerKyc';

/**
 * Give a test seller a verified PAN, GSTIN and bank account, the way
 * production does it without a verification provider: an admin's manual
 * review (the mock provider never verifies anything). Payouts need all three.
 * A GSTIN is added (carrying the PAN) when the seller has none.
 */
export async function verifiedPan(sellerId: string, pan = 'ABCDE1234F', name = 'Test Seller'): Promise<void> {
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { gstNumber: true } });
  await prisma.sellerProfile.update({
    where: { id: sellerId },
    data: {
      panNumber: pan,
      panName: name,
      ...(seller.gstNumber ? {} : { gstNumber: `29${pan}1Z5` }),
      bankAccountEnc: encryptBankAccount('1234567890'),
      bankAccountLast4: '7890',
      bankAccountNo: null,
      bankIfsc: 'HDFC0001234',
      bankAccountName: name,
      bankAccountType: 'CURRENT',
    },
  });
  for (const check of ['PAN', 'GSTIN', 'BANK'] as const) {
    const summary = await reviewSellerKyc({ sellerId, check, decision: 'VERIFY', reviewerId: 'test-admin' });
    const view = { PAN: summary.pan, GSTIN: summary.gstin, BANK: summary.bank }[check];
    if (view.state !== 'VERIFIED') throw new Error(`test ${check} did not verify: ${view.state}`);
  }
}
