import type { CreditNote } from '@clowe/shared';
import { prisma } from '../db';
import { buildCreditNote, invoiceNumberOf } from './taxInvoice';

// ---------------------------------------------------------------------------
// GST credit notes (pre-launch audit 2026-10-21, M3). A returned, refunded
// line stays on its tax invoice — an invoice is never changed once issued —
// and the seller's credit note reduces it: the same line at the same figures,
// naming the invoice, kept as issued.
//
// Numbering follows the invoice's series: the invoice is
// INV-<order number>-<seller>, its credit notes CN-<order number>-<seller>-<n>.
// (For the CA: GST rule 46/53 asks for a consecutive serial of at most 16
// characters, unique per financial year — neither series is that yet.)
// ---------------------------------------------------------------------------

/**
 * Issue it where a return's sale is reversed (every return path), for the
 * line the buyer was invoiced for. Never throws: the refund and the ledger
 * stand either way, and the note can be issued again later.
 */
export async function issueCreditNoteSafe(invoicedOrderItemId: string): Promise<void> {
  await issueCreditNote(invoicedOrderItemId).catch((err) => {
    console.error(`[clowe-api] credit note not issued for line ${invoicedOrderItemId}:`, err instanceof Error ? err.message : err);
  });
}

/** Issue the credit note for one returned line, once. Returns it, or null when there is no invoice to reduce. */
export async function issueCreditNote(orderItemId: string, now: Date = new Date()): Promise<CreditNote | null> {
  const existing = await prisma.creditNote.findUnique({ where: { orderItemId } });
  if (existing) return existing.document as unknown as CreditNote;
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, orderId: true, sellerId: true, order: { select: { orderNumber: true } }, return: { select: { rmaNumber: true } } },
  });
  if (!item) return null;
  const invoiceNumber = invoiceNumberOf(item.order.orderNumber, item.sellerId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const n = (await prisma.creditNote.count({ where: { orderId: item.orderId, sellerId: item.sellerId } })) + 1 + attempt;
    const number = `CN-${item.order.orderNumber}-${item.sellerId.slice(-4).toUpperCase()}-${n}`;
    const doc = await buildCreditNote({
      orderId: item.orderId,
      sellerId: item.sellerId,
      orderItemIds: [item.id],
      creditNoteNumber: number,
      issuedAt: now,
      reason: item.return?.rmaNumber ? `Goods returned (${item.return.rmaNumber})` : 'Goods returned',
    });
    if (!doc) return null;
    try {
      await prisma.creditNote.create({
        data: { number, orderId: item.orderId, sellerId: item.sellerId, orderItemId: item.id, invoiceNumber, totalPaise: doc.totalPaise, document: doc as unknown as object, issuedAt: now },
      });
      return doc;
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      // Issued at the same moment by another path: that one stands.
      const again = await prisma.creditNote.findUnique({ where: { orderItemId } });
      if (again) return again.document as unknown as CreditNote;
      // Otherwise the number was taken: try the next one.
    }
  }
  throw new Error('Could not allocate a credit note number');
}

/** The credit notes against a seller's invoice on an order (all sellers' when sellerId is omitted). */
export async function creditNotesFor(orderId: string, sellerId?: string): Promise<CreditNote[]> {
  const rows = await prisma.creditNote.findMany({ where: { orderId, ...(sellerId ? { sellerId } : {}) }, orderBy: { issuedAt: 'asc' } });
  return rows.map((r) => r.document as unknown as CreditNote);
}
