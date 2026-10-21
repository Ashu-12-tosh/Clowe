import { describe, expect, it } from 'vitest';
import { formatPaise, paymentMethodLabel } from './format';

// Pre-launch audit (2026-10-20): every amount was rounded to the rupee, so a
// ₹1,178.82 payment read ₹1,179 — at checkout and in the admin's payments.
describe('formatPaise', () => {
  it('shows whole rupees without decimals', () => {
    expect(formatPaise(149_900)).toBe('₹1,499');
    expect(formatPaise(0)).toBe('₹0');
    expect(formatPaise(1_00_00_000)).toBe('₹1,00,000');
  });

  it('never rounds paise away', () => {
    expect(formatPaise(117_882)).toBe('₹1,178.82');
    expect(formatPaise(230_895)).toBe('₹2,308.95');
    expect(formatPaise(50)).toBe('₹0.50');
    expect(formatPaise(-6_673_650)).toBe('₹-66,736.50');
  });
});

describe('paymentMethodLabel', () => {
  it('names the way the order was paid, not the provider id', () => {
    expect(paymentMethodLabel('UPI', 'cashfree')).toBe('Online payment (Cashfree)');
    expect(paymentMethodLabel('CARD', 'razorpay')).toBe('Online payment (Razorpay)');
    expect(paymentMethodLabel('COD', 'cod')).toBe('Cash on Delivery');
    expect(paymentMethodLabel('REPLACEMENT', null)).toBe('Replacement — no charge');
    expect(paymentMethodLabel('UPI', 'mock')).toBe('Mock gateway (dev)');
    expect(paymentMethodLabel('UPI', null)).toBe('—');
  });
});
