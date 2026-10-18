import { env } from '../../env';
import type { ShippingProvider } from './ShippingProvider';
import { DelhiveryShippingProvider } from './DelhiveryShippingProvider';
import { MockShippingProvider } from './MockShippingProvider';
import { getSettings } from '../settingsService';

// Delhivery is the only courier. The mock stands in for it unless
// SHIPPING_PROVIDER=delhivery; then staging, unless DELHIVERY_ENV=production,
// where writes stay refused unless DELHIVERY_PRODUCTION_WRITES=true.
function createShippingProvider(): ShippingProvider {
  switch (env.SHIPPING_PROVIDER) {
    case 'delhivery':
      return new DelhiveryShippingProvider({
        token: env.DELHIVERY_API_TOKEN!,
        environment: env.DELHIVERY_ENV,
        baseUrl: env.DELHIVERY_BASE_URL,
        allowProductionWrites: env.DELHIVERY_PRODUCTION_WRITES === 'true',
      });
    case 'mock':
    default:
      // The mock prices every parcel at the admin's flat test rate.
      return new MockShippingProvider({ flatParcelPaise: async () => (await getSettings()).deliveryFeePaise });
  }
}

export const shippingProvider = createShippingProvider();

/** Say at boot which courier connection is live. No probe call; the token is never printed. */
export function logShippingProviderStatus(): void {
  if (shippingProvider.name !== 'delhivery') {
    console.log('[clowe-api] Shipping: mock Delhivery — no real parcels are booked');
    return;
  }
  const writes =
    env.DELHIVERY_ENV === 'production'
      ? env.DELHIVERY_PRODUCTION_WRITES === 'true'
        ? ' — LIVE: bookings, pickups and cancellations are real'
        : ' — read-only: bookings, pickups and cancellations are refused'
      : '';
  console.log(`[clowe-api] Shipping: Delhivery ${env.DELHIVERY_ENV}${writes}`);
}
