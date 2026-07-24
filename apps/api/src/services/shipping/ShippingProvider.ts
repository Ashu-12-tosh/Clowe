export interface ShipmentRequest {
  orderNumber: string;
  orderItemId: string;
  destinationCity: string;
  destinationPincode: string;
}

export interface Shipment {
  awbNumber: string;
  courierName: string;
  trackingUrl: string;
  etaDays: number;
}

/**
 * Shiprocket-style delivery partner abstraction. The mock generates fake
 * AWBs in dev; a real aggregator (Shiprocket/Delhivery) slots in later.
 */
export interface ShippingProvider {
  readonly name: string;
  createShipment(request: ShipmentRequest): Promise<Shipment>;
}
