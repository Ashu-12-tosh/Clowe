import { env } from '../../env';
import type { ShippingProvider } from './ShippingProvider';
import { MockShippingProvider } from './MockShippingProvider';

function createShippingProvider(): ShippingProvider {
  switch (env.SHIPPING_PROVIDER) {
    case 'mock':
    default:
      return new MockShippingProvider();
    // case 'shiprocket': ... // production aggregator
  }
}

export const shippingProvider = createShippingProvider();
