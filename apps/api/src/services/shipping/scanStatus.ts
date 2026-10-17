import type { ShipmentStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// A courier scan, in Delhivery's terms, as our shipment status.
//
// Delhivery asks integrators not to hard-code its flow, so this maps by the
// scan's type and status and treats anything unknown as still moving. The
// exact codes are to be checked against staging responses.
// ---------------------------------------------------------------------------

export interface ScanFields {
  statusType: string;
  status: string;
  code?: string;
}

/** A failed delivery attempt (NDR): Delhivery's EOD-… codes on an undelivered scan. */
export function isFailedAttempt(scan: ScanFields): boolean {
  return scan.statusType.toUpperCase() === 'UD' && /^EOD-/i.test(scan.code ?? '');
}

/**
 * "Not Picked" (X-PNP): Delhivery did not collect the parcel. Our own
 * cancellation before pickup reads the same, so callers check that first.
 */
export function isNotPicked(scan: ScanFields): boolean {
  return (scan.code ?? '').toUpperCase() === 'X-PNP' || (scan.statusType.toUpperCase() === 'UD' && scan.status.trim().toLowerCase() === 'not picked');
}

export function shipmentStatusFromScan(scan: ScanFields): ShipmentStatus {
  const type = scan.statusType.toUpperCase();
  const status = scan.status.trim().toLowerCase();

  if (status === 'lost') return 'LOST';
  if (type === 'CN' || status === 'canceled' || status === 'cancelled') return 'CANCELLED';
  if (type === 'DL') return status === 'rto' ? 'RTO_DELIVERED' : 'DELIVERED';
  if (type === 'RT') return 'RTO_IN_TRANSIT';
  // Reverse pickups: PP waits for the courier at the customer, PU is on its way back.
  if (type === 'PP') return 'PICKUP_REQUESTED';
  if (type === 'PU') return 'IN_TRANSIT';
  // Forward (UD).
  if (status === 'manifested' || status === 'not picked' || status === 'open' || status === 'scheduled') {
    return 'CREATED';
  }
  if (isFailedAttempt(scan)) return 'DELIVERY_FAILED';
  if (status === 'dispatched') return 'OUT_FOR_DELIVERY';
  return 'IN_TRANSIT';
}
