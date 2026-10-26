import type { AddressInfo } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';

// ---------------------------------------------------------------------------
// The delivery PIN a shopper checks dates against, shared by the product
// page and the cart: remembered for this browser session only, and, until
// they type one, a logged-in buyer's default address.
// ---------------------------------------------------------------------------

const KEY = 'clowe.deliveryPin';

export function sessionPin(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberPin(pin: string): void {
  try {
    sessionStorage.setItem(KEY, pin);
  } catch {
    // Storage blocked: the PIN is asked again on the next page.
  }
}

/** The session's PIN, else the logged-in buyer's default address's, else ''. */
export async function startingPin(): Promise<string> {
  const saved = sessionPin();
  if (saved || !getStoredUser()) return saved;
  try {
    const addresses = await api<AddressInfo[]>('/api/addresses', { auth: true });
    return (addresses.find((a) => a.isDefault) ?? addresses[0])?.pincode ?? '';
  } catch {
    return '';
  }
}
