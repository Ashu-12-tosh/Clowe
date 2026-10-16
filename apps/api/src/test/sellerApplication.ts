import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { VENDOR_TERMS_VERSION } from '@clowe/shared';

/** A private document this user uploaded (no bytes behind it: tests only check the reference). */
export async function sellerDocument(prisma: PrismaClient, ownerId: string): Promise<string> {
  const a = await prisma.asset.create({
    data: { provider: 'local', key: `test/${randomBytes(8).toString('hex')}`, purpose: 'SELLER_DOCUMENT', contentType: 'application/pdf', bytes: 10, ownerId },
  });
  return `asset:${a.id}`;
}

/** Everything a seller application needs (Vendor Terms 2.1), with the terms accepted. */
export async function completeApplication(prisma: PrismaClient, userId: string, shopName: string) {
  return {
    shopName,
    panNumber: 'ABCDE1234F',
    bankAccountName: 'Test Traders',
    bankAccountNo: '123456789012',
    bankIfsc: 'HDFC0001234',
    bankName: 'HDFC Bank',
    addressLine1: '1 Market Road',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
    constitutionDoc: await sellerDocument(prisma, userId),
    cancelledChequeDoc: await sellerDocument(prisma, userId),
    signatoryKycDoc: await sellerDocument(prisma, userId),
    acceptVendorTerms: true,
    vendorTermsVersion: VENDOR_TERMS_VERSION,
  };
}
