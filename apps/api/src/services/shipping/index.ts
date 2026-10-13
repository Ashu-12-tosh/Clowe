import { env } from '../../env';
import type { ShippingProvider } from './ShippingProvider';
import { MockShippingProvider } from './MockShippingProvider';

// Delhivery is the only courier. The mock stands in for it until a Delhivery
// token is configured.
function createShippingProvider(): ShippingProvider {
  switch (env.SHIPPING_PROVIDER) {
    case 'mock':
    default:
      return new MockShippingProvider();
  }
}

export const shippingProvider = createShippingProvider();
