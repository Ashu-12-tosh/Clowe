import { createHash } from 'node:crypto';
import type { CourierWarehouseStatus } from '@prisma/client';
import { prisma } from '../../db';
import { shippingProvider } from './index';
import { ShippingProviderError, type WarehouseInput } from './ShippingProvider';

// ---------------------------------------------------------------------------
// Each seller's pickup address, registered with Delhivery as a "warehouse".
//
// Delhivery matches a booking's pickup location by name, exactly, so every
// seller gets one fixed name (CLW-<seller id>: no underscores, which it
// refuses) that never changes. Undelivered parcels and returns go back to the
// same address: the seller's own pickup address, not a central one.
//
// Registered when a seller is approved, again whenever their pickup address
// changes, and — as a backstop — at their first booking. A seller can't book
// or ship until it is ACTIVE; the reason shows in Store Settings and to admins.
// ---------------------------------------------------------------------------

export function warehouseNameFor(sellerId: string): string {
  return `CLW-${sellerId}`;
}

type SellerForWarehouse = {
  id: string;
  shopName: string;
  /** The name on the PAN: the registered business name. */
  panName: string | null;
  storeEmail: string | null;
  storePhone: string | null;
  pickupSameAsBusiness: boolean;
  pickupName: string | null;
  pickupPhone: string | null;
  pickupLine1: string | null;
  pickupLine2: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  pickupPincode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  courierWarehouseName: string | null;
  courierWarehouseStatus: CourierWarehouseStatus;
  courierWarehouseAddressHash: string | null;
  user: { phone: string; email: string | null };
};

/** The address Delhivery collects from, or the fields still missing. */
export function warehouseInputFor(seller: SellerForWarehouse): { input: WarehouseInput } | { missing: string[] } {
  const own = !seller.pickupSameAsBusiness;
  const line1 = (own ? seller.pickupLine1 : seller.addressLine1)?.trim();
  const line2 = (own ? seller.pickupLine2 : seller.addressLine2)?.trim();
  const city = (own ? seller.pickupCity : seller.city)?.trim();
  const state = (own ? seller.pickupState : seller.state)?.trim();
  const pincode = (own ? seller.pickupPincode : seller.pincode)?.trim();
  const phone = (seller.pickupPhone || seller.storePhone || seller.user.phone)?.trim();
  const missing = [
    !line1 && 'street address',
    !city && 'city',
    !state && 'state',
    !(pincode && /^\d{6}$/.test(pincode)) && '6-digit PIN code',
    !phone && 'phone',
  ].filter((m): m is string => !!m);
  if (missing.length > 0) return { missing };
  const address = { line1: [line1, line2].filter(Boolean).join(', '), city: city!, state: state!, pincode: pincode! };
  return {
    input: {
      name: seller.courierWarehouseName ?? warehouseNameFor(seller.id),
      registeredName: (seller.panName || seller.shopName).trim(),
      phone: phone!,
      email: seller.storeEmail ?? seller.user.email ?? null,
      address,
      // Returns and RTO come back to the seller's own pickup address.
      returnAddress: address,
    },
  };
}

function addressHash(input: WarehouseInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.registeredName, input.phone, input.address, input.returnAddress]))
    .digest('hex')
    .slice(0, 32);
}

export interface WarehouseSync {
  status: CourierWarehouseStatus;
  name: string | null;
  error: string | null;
}

/**
 * Register (or update) the seller's pickup address with the courier if it is
 * not already registered as it stands. Never throws for a courier refusal: the
 * outcome is recorded on the seller and returned.
 */
export async function syncWarehouse(sellerId: string, opts: { force?: boolean } = {}): Promise<WarehouseSync> {
  const seller = await prisma.sellerProfile.findUniqueOrThrow({
    where: { id: sellerId },
    include: { user: { select: { phone: true, email: true } } },
  });
  const built = warehouseInputFor(seller);
  if ('missing' in built) {
    const error = `Add your pickup address in Store Settings: ${built.missing.join(', ')} missing`;
    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { courierWarehouseStatus: 'FAILED', courierWarehouseError: error },
    });
    return { status: 'FAILED', name: seller.courierWarehouseName, error };
  }
  const hash = addressHash(built.input);
  if (!opts.force && seller.courierWarehouseStatus === 'ACTIVE' && seller.courierWarehouseAddressHash === hash) {
    return { status: 'ACTIVE', name: seller.courierWarehouseName, error: null };
  }
  try {
    const result = await shippingProvider.upsertWarehouse(built.input);
    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: {
        courierWarehouseName: result.name,
        courierWarehouseStatus: 'ACTIVE',
        courierWarehouseError: null,
        courierWarehouseSyncedAt: new Date(),
        courierWarehouseAddressHash: hash,
      },
    });
    return { status: 'ACTIVE', name: result.name, error: null };
  } catch (err) {
    if (!(err instanceof ShippingProviderError)) throw err;
    const error = `Delhivery: ${err.message}`;
    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { courierWarehouseStatus: 'FAILED', courierWarehouseError: error },
    });
    return { status: 'FAILED', name: seller.courierWarehouseName, error };
  }
}

/** Best effort, for approval and address edits: a failure is recorded, never raised. */
export function syncWarehouseSafe(sellerId: string): Promise<void> {
  return syncWarehouse(sellerId).then(
    () => undefined,
    (err) => console.error('[clowe-api] could not register pickup address for seller', sellerId, err),
  );
}
