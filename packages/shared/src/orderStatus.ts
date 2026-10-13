// ---------------------------------------------------------------------------
// Order line statuses that are not a sale.
//
// A line that was cancelled, returned, or came back undelivered (RTO) never
// counts as revenue, units sold, a customer's spend or a seller's sales. One
// list, so adding a status (as RTO was) cannot leave one report counting it.
// ---------------------------------------------------------------------------

/** The parcel could not be delivered: on its way back to the seller, then back. */
export const RTO_STATUSES = ['RTO_IN_TRANSIT', 'RTO_DELIVERED'] as const;

export const NOT_A_SALE_STATUSES = ['CANCELLED', 'RETURNED', ...RTO_STATUSES] as const;
export type NotASaleStatus = (typeof NOT_A_SALE_STATUSES)[number];

export function isNotASale(status: string): boolean {
  return (NOT_A_SALE_STATUSES as readonly string[]).includes(status);
}
