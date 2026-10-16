import { STORE_CLOSED_MESSAGE } from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { ApiError } from '../utils/ApiError';
import { getSettings } from './settingsService';

// ---------------------------------------------------------------------------
// Before launch (owner's call): production takes payments and books parcels
// on mocks, so a shopper's order would read "paid" with no money taken and no
// courier booked. Until the admin opens the store, nobody but admins and
// accounts an admin marked as test accounts can place an order, and the mock
// gateway marks nothing as paid on production for anyone else. Browsing,
// search, wishlist and cart are untouched.
// ---------------------------------------------------------------------------

/** Admins and admin-marked test accounts: they can order while the store is closed. */
async function isTrusted(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isTestAccount: true } });
  return u?.role === 'ADMIN' || u?.isTestAccount === true;
}

export async function canPlaceOrders(userId: string | null | undefined): Promise<boolean> {
  if ((await getSettings()).storeOpenForOrders) return true;
  return isTrusted(userId);
}

/** Refuses an order (prepaid or COD) while the store is closed to this account. */
export async function assertCanPlaceOrders(userId: string): Promise<void> {
  if (!(await canPlaceOrders(userId))) throw ApiError.forbidden(STORE_CLOSED_MESSAGE, 'STORE_NOT_OPEN');
}

/** On production the mock gateway settles payments only for admins and test accounts. */
export async function assertMockPaymentAllowed(userId: string): Promise<void> {
  if (env.NODE_ENV !== 'production') return;
  if (!(await isTrusted(userId))) {
    throw ApiError.forbidden('Payments are not live yet — nothing has been charged', 'MOCK_PAYMENT_REFUSED');
  }
}
