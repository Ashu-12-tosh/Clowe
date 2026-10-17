import type { StoreOpenChecklistRow } from '@clowe/shared';
import { prisma } from '../db';
import { auditSafe } from './auditService';
import { getSellerKycSummary } from './kyc/sellerKyc';
import { sellerAddressComplete } from './sellerAddress';
import { getSettings } from './settingsService';

/**
 * Onboarding exception (owner's rule, per seller): an admin lets a seller's
 * approved listings go live before the business address or KYC is complete —
 * only while the store is not yet open for orders, and until the optional end
 * date. The "Sold by" box then gives Clowe's support contact. Payouts are
 * never part of it: they still wait for a verified PAN, GSTIN and bank account.
 *
 * Opening the store ends every exception, and is refused while any seller
 * with live listings still lacks a business address or verified KYC.
 */

type ExceptionFields = { onboardingException: boolean; onboardingExceptionUntil: Date | null };

/** Whether the exception holds now, given whether the store is open. */
export function exceptionActive(s: ExceptionFields, storeOpen: boolean, now = new Date()): boolean {
  return s.onboardingException && !storeOpen && (!s.onboardingExceptionUntil || s.onboardingExceptionUntil > now);
}

/** The sellers whose exception holds right now. */
export async function activeExceptionSellerIds(): Promise<Set<string>> {
  if ((await getSettings()).storeOpenForOrders) return new Set();
  const rows = await prisma.sellerProfile.findMany({
    where: { onboardingException: true, OR: [{ onboardingExceptionUntil: null }, { onboardingExceptionUntil: { gt: new Date() } }] },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Everything that must be settled before the store opens: every approved
 * seller with live listings that lacks a complete business address, or whose
 * PAN, GSTIN or bank account is not verified — exceptions included.
 */
export async function storeOpenChecklist(): Promise<StoreOpenChecklistRow[]> {
  const sellers = await prisma.sellerProfile.findMany({
    where: { status: 'APPROVED', products: { some: { status: 'APPROVED', isVisible: true, planHidden: false } } },
    select: {
      id: true,
      shopName: true,
      addressLine1: true,
      city: true,
      state: true,
      pincode: true,
      onboardingException: true,
      _count: { select: { products: { where: { status: 'APPROVED', isVisible: true, planHidden: false } } } },
    },
    orderBy: { shopName: 'asc' },
  });
  const rows: StoreOpenChecklistRow[] = [];
  for (const s of sellers) {
    const kyc = await getSellerKycSummary(s.id);
    const missing: string[] = [];
    if (!sellerAddressComplete(s)) missing.push('business address');
    for (const c of [kyc.pan, kyc.gstin, kyc.bank]) {
      if (c.state !== 'VERIFIED') missing.push(`${c.check === 'BANK' ? 'bank account' : c.check} not verified`);
    }
    if (missing.length) rows.push({ sellerId: s.id, shopName: s.shopName, liveListings: s._count.products, onboardingException: s.onboardingException, missing });
  }
  return rows;
}

/** The store opened for orders: every onboarding exception ends, on the record. */
export async function endExceptionsOnStoreOpen(actorId: string): Promise<number> {
  const ending = await prisma.sellerProfile.findMany({ where: { onboardingException: true }, select: { id: true, shopName: true } });
  if (ending.length === 0) return 0;
  await prisma.sellerProfile.updateMany({ where: { id: { in: ending.map((s) => s.id) } }, data: { onboardingException: false } });
  for (const s of ending) {
    auditSafe({
      actorId,
      actorRole: 'ADMIN',
      module: 'SELLERS',
      action: 'Onboarding exception ended',
      entityType: 'SellerProfile',
      entityId: s.id,
      summary: `${s.shopName}: onboarding exception ended — the store opened for orders`,
    });
  }
  return ending.length;
}
