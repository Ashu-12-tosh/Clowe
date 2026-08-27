export interface ShipmentRequest {
  orderNumber: string;
  orderItemId: string;
  destinationCity: string;
  destinationPincode: string;
  /**
   * Courier the seller picked in "Assign courier". Providers that can't honour
   * it fall back to their own routing — the returned shipment is the truth.
   */
  preferredCourier?: string;
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
  /** Couriers a seller may pick from; empty means the provider decides. */
  readonly couriers: readonly string[];
  createShipment(request: ShipmentRequest): Promise<Shipment>;
}
