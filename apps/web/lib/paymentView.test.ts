import { describe, expect, it } from 'vitest';
import { orderMoneyView, returnView } from './paymentView';

// Pre-launch test 2026-10-30. H3: when the first check after paying failed
// (offline, a timeout), the return page said "Payment not completed — Nothing
// was charged". H12: an order whose payment failed or never happened said
// "Total Paid".

describe('the return page', () => {
  it('never says the payment failed when the server could not be asked', () => {
    expect(returnView({ unreachable: true, result: null })).toBe('CHECKING');
    expect(returnView({ unreachable: false, result: null })).toBe('CHECKING');
  });

  it('keeps waiting, not failing, when a later check cannot reach the server', () => {
    expect(returnView({ unreachable: true, result: { outcome: 'RETRY', message: null, checkout: null } })).toBe('WAITING');
  });

  it('says "not completed" only when the server answered FAILED', () => {
    expect(returnView({ unreachable: false, result: { outcome: 'FAILED', message: null, checkout: null } })).toBe('FAILED');
    expect(returnView({ unreachable: false, result: { outcome: 'PENDING', message: null, checkout: null } })).toBe('WAITING');
    expect(returnView({ unreachable: false, result: { outcome: 'RETRY', message: null, checkout: null } })).toBe('RETRY');
  });
});

describe('an order’s total', () => {
  it('is "Total Paid" only once paid', () => {
    expect(orderMoneyView({ status: 'CONFIRMED', paymentMethod: 'UPI', payment: { status: 'PAID' } })).toEqual({
      totalLabel: 'Total Paid',
      notPaidNote: null,
      showInvoice: true,
    });
  });

  it('says "Not paid" for a payment still pending, with no invoice', () => {
    expect(orderMoneyView({ status: 'PLACED', paymentMethod: 'UPI', payment: { status: 'CREATED' } })).toEqual({
      totalLabel: 'Order Total',
      notPaidNote: 'Not paid yet',
      showInvoice: false,
    });
  });

  it('says nothing was charged for an order cancelled after a failed payment', () => {
    expect(orderMoneyView({ status: 'CANCELLED', paymentMethod: 'CARD', payment: { status: 'FAILED' } })).toEqual({
      totalLabel: 'Order Total',
      notPaidNote: 'Not paid — nothing was charged',
      showInvoice: false,
    });
  });

  it('a paid order that was cancelled says the payment is being refunded', () => {
    expect(orderMoneyView({ status: 'CANCELLED', paymentMethod: 'UPI', payment: { status: 'PAID' } }).notPaidNote).toBe('Cancelled — your payment is being refunded');
  });

  it('a cash-on-delivery order is paid to the courier', () => {
    expect(orderMoneyView({ status: 'CONFIRMED', paymentMethod: 'COD', payment: { status: 'CREATED' } }).totalLabel).toBe('To Pay on Delivery');
  });
});
