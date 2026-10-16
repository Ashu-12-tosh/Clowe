import { afterEach, describe, expect, it } from 'vitest';
import { clearToasts, getToasts } from '@/lib/toast';
import { announceBooking, bookingNotice } from './bookingNotice';

afterEach(() => clearToasts());

describe('after booking a shipment', () => {
  it('toasts success when every line was booked', () => {
    const message = announceBooking({ updated: 2, skipped: [] });
    expect(message).toBe('2 item(s) booked with Delhivery — the label now carries the AWB');
    expect(getToasts()).toEqual([expect.objectContaining({ kind: 'success', message })]);
  });

  it('toasts an error, with the reason, when a line was left unbooked', () => {
    const message = announceBooking({ updated: 1, skipped: [{ itemId: 'i2', reason: 'Not packed yet' }] });
    expect(message).toContain('1 skipped (Not packed yet)');
    expect(getToasts()).toEqual([expect.objectContaining({ kind: 'error', message })]);
  });

  it('counts nothing booked as an error', () => {
    expect(bookingNotice({ updated: 0, skipped: [{ itemId: 'i1', reason: 'Pincode not serviceable' }] }).kind).toBe('error');
  });
});
