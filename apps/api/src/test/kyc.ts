import { prisma } from '../db';
import { runSellerKyc } from '../services/kyc/sellerKyc';

/**
 * Give a test seller a PAN, verified the way production does it. Tests run
 * the mock KYC provider (test/env.ts), so this costs nothing; a well-formed
 * PAN with any ordinary name verifies.
 */
export async function verifiedPan(sellerId: string, pan = 'ABCDE1234F', name = 'Test Seller'): Promise<void> {
  await prisma.sellerProfile.update({ where: { id: sellerId }, data: { panNumber: pan, panName: name } });
  const summary = await runSellerKyc(sellerId, ['PAN']);
  if (summary.pan.state !== 'VERIFIED') throw new Error(`test PAN did not verify: ${summary.pan.state}`);
}
