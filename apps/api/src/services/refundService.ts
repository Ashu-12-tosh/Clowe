import { prisma } from '../db';
import { paymentProvider } from './payments';
import { sendToUserSafe } from './messaging';

/**
 * A Cash on Delivery order's refunds are bank transfers an admin makes by
 * hand (there is no online payment to refund to): they wait PENDING under
 * this provider until the admin records the transfer's reference.
 */
export const MANUAL_COD_PROVIDER = 'manual-cod';

function loadRefund(refundId: string) {
  return prisma.refund.findUnique({
    where: { id: refundId },
    include: {
      order: { include: { payment: true, user: { select: { id: true, phone: true } } } },
      return: { include: { orderItem: { select: { title: true } }, codRefundAccount: { select: { last4: true } } } },
    },
  });
}
type LoadedRefund = NonNullable<Awaited<ReturnType<typeof loadRefund>>>;

const rupeesOf = (refund: LoadedRefund) => (refund.amountPaise / 100).toFixed(2);
// A goodwill refund an admin issued has no return behind it, so the message
// describes the order rather than a returned item.
const subjectOf = (refund: LoadedRefund) =>
  refund.return ? `"${refund.return.orderItem.title}"` : `order ${refund.order.orderNumber}`;

/**
 * Mark a refund paid: refund PROCESSED with the provider's (or bank's)
 * reference, return REFUNDED, the payment REFUNDED once its refunds cover
 * all of it, and the customer told in the app and by message.
 */
async function settleRefund(refund: LoadedRefund, providerRefundId: string, told: { inApp: string; message: string }) {
  const payment = refund.order.payment;
  const processedBefore = (
    await prisma.refund.aggregate({
      where: { orderId: refund.orderId, status: 'PROCESSED' },
      _sum: { amountPaise: true },
    })
  )._sum.amountPaise ?? 0;
  const coversPayment = payment !== null && processedBefore + refund.amountPaise >= payment.amountPaise;
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
    // paidAt stays: when the money was taken does not change on refund.
    ...(coversPayment && payment
      ? [prisma.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' as const } })]
      : []),
    prisma.notification.create({
      data: { userId: refund.order.user.id, type: 'REFUND_PROCESSED', title: 'Refund processed 💸', body: told.inApp },
    }),
  ]);
  sendToUserSafe(
    refund.order.user.id,
    { channel: 'whatsapp', to: `+91${refund.order.user.phone}`, body: told.message },
    { critical: true },
  );
}

/**
 * Process a PENDING refund through the payment gateway (mock simulates it).
 * On success: refund PROCESSED, return REFUNDED, customer notified, and the
 * payment marked REFUNDED once its refunds cover all of it.
 * On gateway failure the refund is marked FAILED (kept for retry/inspection);
 * the return stays RECEIVED and the payment stays PAID.
 *
 * A Cash on Delivery order's refund does not go to the gateway: it waits for
 * an admin to pay it by bank transfer (completeCodRefund), and the customer
 * is told it is on its way.
 */
export async function processRefund(refundId: string): Promise<void> {
  const refund = await loadRefund(refundId);
  if (!refund || refund.status !== 'PENDING') return;
  const rupees = rupeesOf(refund);
  const subject = subjectOf(refund);

  if (refund.order.paymentMethod === 'COD') {
    if (refund.provider !== MANUAL_COD_PROVIDER) {
      await prisma.refund.update({ where: { id: refund.id }, data: { provider: MANUAL_COD_PROVIDER } });
    }
    // A return's refund was announced when the item was received; tell the
    // buyer here only about one with no return behind it (an admin's).
    if (refund.returnId) return;
    const last4 = refund.return?.codRefundAccount?.last4;
    const to = last4 ? `your bank account ending ${last4}` : 'your bank account (our support team will contact you for the details)';
    await prisma.notification.create({
      data: {
        userId: refund.order.user.id,
        type: 'REFUND_INITIATED',
        title: 'Refund on its way',
        body: `We will transfer ₹${rupees} for ${subject} (${refund.order.orderNumber}) to ${to}. We will tell you as soon as it is sent.`,
      },
    });
    return;
  }

  try {
    const providerRefundId = await paymentProvider.refund(refund.order.payment?.providerPaymentId ?? '', refund.amountPaise);
    await settleRefund(refund, providerRefundId, {
      inApp: `₹${rupees} refunded for ${subject} (${refund.order.orderNumber}). It should reflect in your account within 5–7 business days.`,
      message: `Clowe: your refund of ₹${rupees} for ${subject} has been processed. Expect it in 5–7 business days. 💸`,
    });
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

/**
 * An admin has paid a Cash on Delivery refund by bank transfer: record the
 * bank's reference (UTR) and tell the customer. Refuses anything but a
 * PENDING manual COD refund.
 */
export async function completeCodRefund(refundId: string, reference: string): Promise<LoadedRefund> {
  const refund = await loadRefund(refundId);
  if (!refund || refund.provider !== MANUAL_COD_PROVIDER) throw new Error('NOT_A_COD_REFUND');
  if (refund.status !== 'PENDING') throw new Error('ALREADY_SETTLED');
  const rupees = rupeesOf(refund);
  const subject = subjectOf(refund);
  const last4 = refund.return?.codRefundAccount?.last4;
  const account = last4 ? `your bank account ending ${last4}` : 'your bank account';
  await settleRefund(refund, reference, {
    inApp: `₹${rupees} for ${subject} (${refund.order.orderNumber}) has been sent to ${account}. Bank reference: ${reference}.`,
    message: `Clowe: your refund of ₹${rupees} for ${subject} has been sent to ${account}. Bank reference ${reference}. 💸`,
  });
  return refund;
}

/**
 * Refund what is left of a paid order's payment, through the gateway — the
 * same path a return's refund takes. Called when an order, or what remains of
 * it, is cancelled. Nothing is owed on an unpaid or not-yet-collected COD
 * order. The refund is recorded either way it goes: PROCESSED, or FAILED for
 * an admin to retry, never silently skipped.
 */
/**
 * Refund part of a paid order — the lines one seller cancelled while the rest
 * of the order goes ahead. Capped at what is left of the payment; recorded
 * PROCESSED or FAILED like any refund. Nothing on an unpaid or COD order.
 */
export async function refundOrderPart(
  orderId: string,
  amountPaise: number,
  reason: string,
): Promise<{ id: string; status: string; amountPaise: number } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true, refunds: { where: { status: { in: ['PENDING', 'PROCESSED'] } } } },
  });
  if (!order?.payment || order.payment.status !== 'PAID') return null;
  const alreadyRefunded = order.refunds.reduce((sum, r) => sum + r.amountPaise, 0);
  const amount = Math.min(amountPaise, order.payment.amountPaise - alreadyRefunded);
  if (amount <= 0) return null;
  const refund = await prisma.refund.create({
    data: { orderId, amountPaise: amount, provider: order.payment.provider, status: 'PENDING', reason },
  });
  await processRefund(refund.id);
  const settled = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  return { id: settled.id, status: settled.status, amountPaise: settled.amountPaise };
}

export async function refundCancelledOrder(
  orderId: string,
  reason: string,
  issuedByAdminId?: string,
): Promise<{ id: string; status: string; amountPaise: number } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true, refunds: { where: { status: { in: ['PENDING', 'PROCESSED'] } } } },
  });
  if (!order?.payment || order.payment.status !== 'PAID') return null;
  const alreadyRefunded = order.refunds.reduce((sum, r) => sum + r.amountPaise, 0);
  const amountPaise = order.payment.amountPaise - alreadyRefunded;
  if (amountPaise <= 0) return null;

  const refund = await prisma.refund.create({
    data: {
      orderId,
      amountPaise,
      provider: order.payment.provider,
      status: 'PENDING',
      reason,
      issuedByAdminId: issuedByAdminId ?? null,
    },
  });
  await processRefund(refund.id);
  const settled = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  return { id: settled.id, status: settled.status, amountPaise: settled.amountPaise };
}
