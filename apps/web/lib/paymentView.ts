import type { PaymentConfirmResult } from '@clowe/shared';

// ---------------------------------------------------------------------------
// What the buyer is told about a payment. Only the server's answer may say
// "nothing was charged" or "paid": a check that could not be made is shown as
// still checking, and an order is "paid" only when the money was taken
// (pre-launch test H3 and H12).
// ---------------------------------------------------------------------------

/** The return page's state: checking, waiting on the bank, a failed attempt, or a final no. */
export type ReturnView = 'CHECKING' | 'WAITING' | 'RETRY' | 'FAILED';

export function returnView(s: { unreachable: boolean; result: PaymentConfirmResult | null }): ReturnView {
  if (!s.result) return 'CHECKING';
  if (s.unreachable || s.result.outcome === 'PENDING') return 'WAITING';
  if (s.result.outcome === 'RETRY') return 'RETRY';
  if (s.result.outcome === 'FAILED') return 'FAILED';
  if (s.result.outcome === 'PAID') return 'CHECKING'; // on the way to the order
  return 'WAITING'; // an answer this page does not know: not final
}

export interface OrderMoneyView {
  /** "Total Paid" only once the money was taken. */
  totalLabel: 'Total Paid' | 'To Pay on Delivery' | 'Order Total';
  /** Under the total: not paid, or paid and refunded because the order was cancelled. */
  notPaidNote: string | null;
  /** An invoice is for a sale: a paid order, or a COD order going ahead. */
  showInvoice: boolean;
}

export function orderMoneyView(order: { status: string; paymentMethod: string; payment: { status: string } | null }): OrderMoneyView {
  const paid = order.payment?.status === 'PAID' || order.payment?.status === 'REFUNDED';
  const cod = order.paymentMethod === 'COD';
  const cancelled = order.status === 'CANCELLED';
  return {
    totalLabel: paid ? 'Total Paid' : cod && !cancelled ? 'To Pay on Delivery' : 'Order Total',
    notPaidNote: paid
      ? cancelled
        ? 'Cancelled — your payment is being refunded'
        : null
      : cod
        ? null
        : cancelled
          ? 'Not paid — nothing was charged'
          : 'Not paid yet',
    showInvoice: paid || (cod && !cancelled),
  };
}
