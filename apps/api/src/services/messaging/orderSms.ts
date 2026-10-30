// ---------------------------------------------------------------------------
// Order SMS at the tracking steps — off for now.
//
// Every SMS in India goes through a DLT-registered template, and the order
// templates are not approved yet (only the login OTP one is). The steps
// already call this; to switch one on, add its approved template id below
// and send through the SMS panel. Until then nothing is sent and nothing is
// charged.
// ---------------------------------------------------------------------------

export type OrderSmsEvent = 'SHIPPED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'DELIVERY_FAILED' | 'RTO';

/** Approved DLT template ids, by event. Empty: no order SMS is sent. */
export const ORDER_SMS_TEMPLATES: Partial<Record<OrderSmsEvent, string>> = {};

/** Calls made while switched off, for tests (never the phone number). */
export const orderSmsCalls: { event: OrderSmsEvent; orderNumber: string }[] = [];

export function sendOrderSms(event: OrderSmsEvent, _phone: string, vars: { orderNumber: string; awb?: string; reason?: string }): void {
  if (!ORDER_SMS_TEMPLATES[event]) {
    if (orderSmsCalls.length < 500) orderSmsCalls.push({ event, orderNumber: vars.orderNumber });
    return;
  }
  // Switched on per template: wire to the SMS panel here (DLT template, sender CLOWEP).
}
