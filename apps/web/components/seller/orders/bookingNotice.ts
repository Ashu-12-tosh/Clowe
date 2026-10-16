import type { SellerOrderBulkResult } from '@clowe/shared';
import { toast } from '@/lib/toast';

/** What the seller is told after confirming a Delhivery booking. */
export function bookingNotice(result: SellerOrderBulkResult): { kind: 'success' | 'error'; message: string } {
  const message =
    `${result.updated} item(s) booked with Delhivery — the label now carries the AWB` +
    (result.skipped.length > 0 ? ` · ${result.skipped.length} skipped (${result.skipped[0]!.reason})` : '');
  // Anything left unbooked needs the seller's attention, like the bulk actions.
  return { kind: result.updated === 0 || result.skipped.length > 0 ? 'error' : 'success', message };
}

/** Toast the booking's outcome; returns the message for the page's own notice. */
export function announceBooking(result: SellerOrderBulkResult): string {
  const { kind, message } = bookingNotice(result);
  toast[kind](message);
  return message;
}
