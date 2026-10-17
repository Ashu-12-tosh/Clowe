/**
 * The seller's business address, which the "Sold by" box shows on every
 * product page (Consumer Protection (E-Commerce) Rules, 2020: the seller's
 * name, geographic address, customer-care contact and GSTIN). A seller
 * without one cannot sell: their listings stay hidden from shoppers until
 * Store Settings has the address line, city, state and PIN code.
 */

type Address = { addressLine1: string | null; city: string | null; state: string | null; pincode: string | null };

export function sellerAddressComplete(s: Address): boolean {
  return [s.addressLine1, s.city, s.state].every((v) => !!v?.trim()) && /^\d{6}$/.test(s.pincode?.trim() ?? '');
}

/** The address as one line for the "Sold by" box. */
export function sellerAddressLine(s: Address & { addressLine2?: string | null; landmark?: string | null }): string | null {
  if (!sellerAddressComplete(s)) return null;
  return [s.addressLine1, s.addressLine2, s.landmark, s.city, `${s.state} ${s.pincode}`]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join(', ');
}
