import { prisma } from '../db';
import { paymentProvider } from './payments';
import { sendToUserSafe } from './messaging';

/**
 * Process a PENDING refund through the payment gateway (mock simulates it).
 * On success: refund PROCESSED, return REFUNDED, customer notified.
 * On gateway failure the refund is marked FAILED (kept for retry/inspection);
 * the return stays RECEIVED.
 */
export async function processRefund(refundId: string): Promise<void> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: {
      order: { include: { payment: true, user: { select: { id: true, phone: true } } } },
      return: { include: { orderItem: { select: { title: true } } } },
    },
  });
  if (!refund || refund.status !== 'PENDING') return;

  const rupees = (refund.amountPaise / 100).toFixed(2);
  // A goodwill refund an admin issued has no return behind it, so the ledger
  // entry describes the order rather than a returned item.
  const subject = refund.return
    ? `"${refund.return.orderItem.title}"`
    : `order ${refund.order.orderNumber}`;
  try {
    const providerRefundId = await paymentProvider.refund(
      refund.order.payment?.providerPaymentId ?? '',
      refund.amountPaise,
    );
    await prisma.$transaction([
      prisma.refund.update({
        where: { id: refund.id },
        data: { status: 'PROCESSED', providerRefundId, processedAt: new Date() },
      }),
      ...(refund.returnId
        ? [
            prisma.return.update({
              where: { id: refund.returnId },
              data: { status: 'REFUNDED' as const, resolvedAt: new Date() },
            }),
          ]
        : []),
      prisma.notification.create({
        data: {
          userId: refund.order.user.id,
          type: 'REFUND_PROCESSED',
          title: 'Refund processed 💸',
          body: `₹${rupees} refunded for ${subject} (${refund.order.orderNumber}). It should reflect in your account within 5–7 business days.`,
        },
      }),
    ]);
    sendToUserSafe(
      refund.order.user.id,
      {
        channel: 'whatsapp',
        to: `+91${refund.order.user.phone}`,
        body: `Clowe: your refund of ₹${rupees} for ${subject} has been processed. Expect it in 5–7 business days. 💸`,
      },
      { critical: true },
    );
  } catch (err) {
    console.error('[clowe-api] refund failed:', err);
    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: 'FAILED',
        failureReason: err instanceof Error ? err.message : 'Unknown error',
      },
    });
  }
}
