import { createHash } from 'node:crypto';
import type { CourierWarehouseStatus } from '@prisma/client';
import { prisma } from '../../db';
import { shippingProvider } from './index';
import { ShippingProviderError, type PostalAddress, type WarehouseInput } from './ShippingProvider';

// ---------------------------------------------------------------------------
// Each seller's addresses, registered with Delhivery as "warehouses".
//
// Delhivery matches a booking's pickup location by name, exactly, so every
// seller gets one fixed name (CLW-<seller id>: no underscores, which it
// refuses) that never changes. Parcels go back to the seller's return
// address from Store Settings when one is set, otherwise to the pickup
// address: undelivered parcels (RTO) by the warehouse's return address, and
// customer returns (reverse pickups) by a second warehouse registered at the
// return address (CLW-<seller id>-R), since Delhivery delivers a reverse
// pickup to the warehouse it names.
//
// Registered when a seller is approved, again whenever either address
// changes, and — as a backstop — at their first booking. A seller can't book
// or ship until it is ACTIVE; the reason shows in Store Settings and to admins.
// ---------------------------------------------------------------------------

export function warehouseNameFor(sellerId: string): string {
  return `CLW-${sellerId}`;
}

/** The warehouse at a separate return address. */
export function returnWarehouseNameFor(sellerId: string): string {
  return `CLW-${sellerId}-R`;
}

type SellerAddresses = {
  pickupSameAsBusiness: boolean;
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
  returnAddressSameAsPickup: boolean;
  returnLine1: string | null;
  returnCity: string | null;
  returnState: string | null;
  returnPincode: string | null;
};

type SellerForWarehouse = SellerAddresses & {
  id: string;
  shopName: string;
  /** The name on the PAN: the registered business name. */
  panName: string | null;
  storeEmail: string | null;
  storePhone: string | null;
  pickupName: string | null;
  pickupPhone: string | null;
  courierWarehouseName: string | null;
  courierWarehouseStatus: CourierWarehouseStatus;
  courierWarehouseAddressHash: string | null;
  user: { phone: string; email: string | null };
};

const validPin = (pin: string | null | undefined) => !!pin && /^\d{6}$/.test(pin);

/**
 * The seller's separate return address, when Store Settings has one: null when
 * returns go to the pickup address. Partly filled in, it says what is missing.
 */
export function separateReturnAddress(seller: SellerAddresses): { address: PostalAddress | null; missing: string[] } {
  if (seller.returnAddressSameAsPickup) return { address: null, missing: [] };
  const line1 = seller.returnLine1?.trim();
  const city = seller.returnCity?.trim();
  const state = seller.returnState?.trim();
  const pincode = seller.returnPincode?.trim();
  const missing = [
    !line1 && 'street address',
    !city && 'city',
    !state && 'state',
    !validPin(pincode) && '6-digit PIN code',
  ].filter((m): m is string => !!m);
  if (missing.length > 0) return { address: null, missing };
  return { address: { line1: line1!, city: city!, state: state!, pincode: pincode! }, missing: [] };
}

/** Where returned parcels go: the return address if set, otherwise the pickup address. */
export function returnPincodeOf(seller: SellerAddresses, pickupPincode: string | null): string | null {
  return separateReturnAddress(seller).address?.pincode ?? pickupPincode;
}

export interface WarehouseInputs {
  /** The pickup warehouse; its return address is where RTO parcels go. */
  input: WarehouseInput;
  /** A second warehouse at a separate return address, for reverse pickups; null when returns go to the pickup address. */
  returnInput: WarehouseInput | null;
}

/** What Delhivery is given, or the fields still missing. */
export function warehouseInputFor(seller: SellerForWarehouse): WarehouseInputs | { missing: string[]; what: string } {
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
    !validPin(pincode) && '6-digit PIN code',
    !phone && 'phone',
  ].filter((m): m is string => !!m);
  if (missing.length > 0) return { missing, what: 'pickup address' };
  const separate = separateReturnAddress(seller);
  if (separate.missing.length > 0) return { missing: separate.missing, what: 'return address' };

  const pickup = { line1: [line1, line2].filter(Boolean).join(', '), city: city!, state: state!, pincode: pincode! };
  const returnTo = separate.address ?? pickup;
  const base = {
    registeredName: (seller.panName || seller.shopName).trim(),
    phone: phone!,
    email: seller.storeEmail ?? seller.user.email ?? null,
  };
  return {
    input: { ...base, name: seller.courierWarehouseName ?? warehouseNameFor(seller.id), address: pickup, returnAddress: returnTo },
    returnInput: separate.address
      ? { ...base, name: returnWarehouseNameFor(seller.id), address: separate.address, returnAddress: separate.address }
      : null,
  };
}

function addressHash(inputs: WarehouseInputs): string {
  const parts = [inputs.input, inputs.returnInput].map((i) => (i ? [i.registeredName, i.phone, i.address, i.returnAddress] : null));
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export interface WarehouseSync {
  status: CourierWarehouseStatus;
  name: string | null;
  /** The warehouse reverse pickups go to: the return one when set, else the pickup one. */
  returnName: string | null;
  error: string | null;
}

/**
 * Register (or update) the seller's addresses with the courier if they are
 * not already registered as they stand. Never throws for a courier refusal:
 * the outcome is recorded on the seller and returned.
 */
export async function syncWarehouse(sellerId: string, opts: { force?: boolean } = {}): Promise<WarehouseSync> {
  const seller = await prisma.sellerProfile.findUniqueOrThrow({
    where: { id: sellerId },
    include: { user: { select: { phone: true, email: true } } },
  });
  const current = (): WarehouseSync => ({
    status: seller.courierWarehouseStatus,
    name: seller.courierWarehouseName,
    returnName: seller.courierReturnWarehouseName ?? seller.courierWarehouseName,
    error: seller.courierWarehouseError,
  });
  const fail = async (error: string): Promise<WarehouseSync> => {
    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { courierWarehouseStatus: 'FAILED', courierWarehouseError: error },
    });
    return { ...current(), status: 'FAILED', error };
  };

  const built = warehouseInputFor(seller);
  if ('missing' in built) return fail(`Add your ${built.what} in Store Settings: ${built.missing.join(', ')} missing`);
  const hash = addressHash(built);
  if (!opts.force && seller.courierWarehouseStatus === 'ACTIVE' && seller.courierWarehouseAddressHash === hash) {
    return current();
  }
  try {
    const result = await shippingProvider.upsertWarehouse(built.input);
    const returnResult = built.returnInput ? await shippingProvider.upsertWarehouse(built.returnInput) : null;
    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: {
        courierWarehouseName: result.name,
        courierReturnWarehouseName: returnResult?.name ?? null,
        courierWarehouseStatus: 'ACTIVE',
        courierWarehouseError: null,
        courierWarehouseSyncedAt: new Date(),
        courierWarehouseAddressHash: hash,
      },
    });
    return { status: 'ACTIVE', name: result.name, returnName: returnResult?.name ?? result.name, error: null };
  } catch (err) {
    if (!(err instanceof ShippingProviderError)) throw err;
    return fail(`Delhivery: ${err.message}`);
  }
}

/** Best effort, for approval and address edits: a failure is recorded, never raised. */
export function syncWarehouseSafe(sellerId: string): Promise<void> {
  return syncWarehouse(sellerId).then(
    () => undefined,
    (err) => console.error('[clowe-api] could not register pickup address for seller', sellerId, err),
  );
}
