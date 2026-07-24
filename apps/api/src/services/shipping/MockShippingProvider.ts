import { randomInt } from 'node:crypto';
import type { Shipment, ShipmentRequest, ShippingProvider } from './ShippingProvider';

const COURIERS = ['Delhivery', 'BlueDart', 'Ekart Logistics', 'XpressBees', 'DTDC'];

/** Dev provider: fabricates a plausible AWB + courier without external calls. */
export class MockShippingProvider implements ShippingProvider {
  readonly name = 'mock';

  async createShipment(request: ShipmentRequest): Promise<Shipment> {
    const courierName = COURIERS[randomInt(COURIERS.length)];
    const awbNumber = `AWB${Date.now().toString().slice(-8)}${randomInt(100, 999)}`;
    return {
      awbNumber,
      courierName,
      // Mock tracking points at our own public tracking page.
      trackingUrl: `/track?orderNumber=${encodeURIComponent(request.orderNumber)}`,
      etaDays: 3 + randomInt(0, 4),
    };
  }
}
