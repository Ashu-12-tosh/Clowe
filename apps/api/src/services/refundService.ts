import { prisma } from '../db';
import { GatewayError, providerFor } from './payments';
import type { GatewayRefund } from './payments/PaymentProvider';
import { sendToUserSafe } from './messaging';
import { recordAudit } from './auditService';
import { noteSplitRefund, refundSplitsFor } from './easySplit';

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
async function settleRefund(
  refund: LoadedRefund,
  providerRefundId: string,
  told: { inApp: string; message: string },
  gateway: { providerStatus?: string | null; arn?: string | null } = {},
): Promise<boolean> {
  const payment = refund.order.payment;
  // Claimed with a conditional update: the gateway's webhook and the refund
  // poller can both carry the same answer, and the buyer hears it once.
  const settled = await prisma.$transaction(async (tx) => {
    const claim = await tx.refund.updateMany({
      where: { id: refund.id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: {
        status: 'PROCESSED',
        providerRefundId,
        processedAt: new Date(),
        failureReason: null,
        ...(gateway.providerStatus ? { providerStatus: gateway.providerStatus } : {}),
        ...(gateway.arn ? { arn: gateway.arn } : {}),
      },
    });
    if (claim.count === 0) return false;
    const processed = (
      await tx.refund.aggregate({
        where: { orderId: refund.orderId, status: 'PROCESSED' },
        _sum: { amountPaise: true },
      })
    )._sum.amountPaise ?? 0;
    if (refund.returnId) {
      await tx.return.update({
        where: { id: refund.returnId },
        data: { status: 'REFUNDED', resolvedAt: new Date() },
      });
    }
    // paidAt stays: when the money was taken does not change on refund.
    if (payment && processed >= payment.amountPaise) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });
    }
    await tx.notification.create({
      data: { userId: refund.order.user.id, type: 'REFUND_PROCESSED', title: 'Refund processed 💸', body: told.inApp },
    });
    return true;
  });
  if (!settled) return false;
  sendToUserSafe(
    refund.order.user.id,
    { channel: 'whatsapp', to: `+91${refund.order.user.phone}`, body: told.message },
    { critical: true },
  );
  return true;
}

/**
 * Process a PENDING refund through the gateway that took the payment (mock
 * simulates it). On success: refund PROCESSED, return REFUNDED, customer
 * notified, and the payment marked REFUNDED once its refunds cover all of it.
 * A gateway that settles refunds later (Cashfree) leaves it PROCESSING until
 * its webhook or the refund poller brings the final answer.
 * On gateway failure the refund is marked FAILED (kept for an admin's retry);
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

  await submitToGateway(refund);
}

/** The id the gateway knows this attempt by: ours, with R1, R2, … on a retry. */
export function gatewayRefundId(refund: { id: string; attempts: number }): string {
  return refund.attempts > 0 ? `${refund.id}R${refund.attempts}` : refund.id;
}

/**
 * Send a PENDING refund to the gateway that took the payment.
 *
 * It is claimed first (PENDING → PROCESSING) so two callers never send it
 * twice. Then, by the gateway's answer:
 *   SUCCESS  PROCESSED, the buyer told it is on its way, with the bank's
 *            reference (ARN) when there is one
 *   PENDING  stays PROCESSING; the webhook or the refund poller finishes it
 *   FAILED   FAILED with the gateway's reason, for an admin to retry
 * No answer at all (timeout, 5xx): it stays PROCESSING. The gateway refund id
 * is ours, so the poller can ask about it by that id and, if the gateway
 * never got it, send it again as the same refund.
 */
async function submitToGateway(refund: LoadedRefund): Promise<void> {
  const payment = refund.order.payment;
  // The refund goes back through the gateway that took the payment, whatever
  // the gateway is today; its provider label says so.
  const claim = await prisma.refund.updateMany({
    where: { id: refund.id, status: 'PENDING' },
    data: { status: 'PROCESSING', submittedAt: new Date(), failureReason: null, ...(payment ? { provider: payment.provider } : {}) },
  });
  if (claim.count === 0) return;

  const gateway = payment ? providerFor(payment.provider) : null;
  if (!payment || !gateway) {
    await failRefund(
      refund.id,
      payment ? `Paid through ${payment.provider}, which is not connected here — refund it by hand` : 'No payment on this order',
    );
    return;
  }
  // Cashfree refunds by its order id; Razorpay by the payment id.
  if (gateway.name === 'cashfree' && !payment.providerOrderId) {
    await failRefund(refund.id, 'The payment has no gateway order to refund against');
    return;
  }
  try {
    const answer = await gateway.refund({
      providerOrderId: payment.providerOrderId ?? '',
      providerPaymentId: payment.providerPaymentId ?? '',
      refundId: gatewayRefundId(refund),
      amountPaise: refund.amountPaise,
      note: refund.reason ?? `Refund for ${refund.order.orderNumber}`,
      splits: payment.settlementMode === 'easy_split' ? await refundSplitsFor(refund.id) : undefined,
    });
    await applyGatewayAnswer(refund.id, answer);
  } catch (err) {
    console.error('[clowe-api] refund failed:', err instanceof Error ? err.message : err);
    if (err instanceof GatewayError && err.uncertain && gateway.fetchRefund) {
      // It may have reached the gateway: leave it PROCESSING for the poller.
      await prisma.refund.update({ where: { id: refund.id }, data: { providerStatus: 'UNCONFIRMED' } });
      return;
    }
    await failRefund(refund.id, err instanceof Error ? err.message : 'Unknown error');
  }
}

async function failRefund(refundId: string, reason: string, providerStatus?: string): Promise<void> {
  const failed = await prisma.refund.updateMany({
    where: { id: refundId, status: { in: ['PENDING', 'PROCESSING'] } },
    data: { status: 'FAILED', failureReason: reason.slice(0, 500), ...(providerStatus ? { providerStatus } : {}) },
  });
  if (failed.count === 0) return;
  await recordAudit({
    actorRole: 'SYSTEM',
    module: 'PAYMENTS',
    action: 'Refund failed',
    entityType: 'Refund',
    entityId: refundId,
    summary: `Refund ${refundId} failed: ${reason.slice(0, 200)}`,
    severity: 'HIGH',
    status: 'FAILED',
  });
}

/** Apply what the gateway said about a PROCESSING refund. Idempotent. */
async function applyGatewayAnswer(refundId: string, answer: GatewayRefund): Promise<void> {
  const refund = await loadRefund(refundId);
  if (!refund || refund.status !== 'PROCESSING') return;
  const rupees = rupeesOf(refund);
  const subject = subjectOf(refund);

  if (answer.status === 'SUCCESS') {
    const ref = answer.arn ? ` Bank reference: ${answer.arn}.` : '';
    const settled = await settleRefund(
      refund,
      answer.providerRefundId || gatewayRefundId(refund),
      {
        inApp: `₹${rupees} refunded for ${subject} (${refund.order.orderNumber}). It should reflect in your account within 5–7 business days.${ref}`,
        message: `Clowe: your refund of ₹${rupees} for ${subject} has been processed. Expect it in 5–7 business days.${ref} 💸`,
      },
      { providerStatus: answer.providerStatus, arn: answer.arn },
    );
    if (settled) await noteSplitRefund(refund.id);
    return;
  }
  if (answer.status === 'FAILED') {
    await failRefund(refund.id, answer.message || `The gateway refused the refund (${answer.providerStatus})`, answer.providerStatus);
    return;
  }
  // Accepted, not final: keep what we know, and tell the buyer once.
  const firstWord = refund.providerStatus === null || refund.providerStatus === 'UNCONFIRMED';
  await prisma.refund.update({
    where: { id: refund.id },
    data: {
      providerRefundId: answer.providerRefundId || null,
      providerStatus: answer.providerStatus,
      ...(answer.arn ? { arn: answer.arn } : {}),
    },
  });
  // A return's refund was announced when the item came back.
  if (firstWord && !refund.returnId) {
    await prisma.notification.create({
      data: {
        userId: refund.order.user.id,
        type: 'REFUND_INITIATED',
        title: 'Refund initiated 💰',
        body: `Your refund of ₹${rupees} for ${subject} (${refund.order.orderNumber}) has been started. It usually reaches you within 5–7 business days.`,
      },
    });
  }
}

/**
 * Ask the gateway about a PROCESSING refund and apply the answer: from the
 * refund poller and the gateway's refund webhook. A refund the gateway has
 * never heard of (the first send was lost) is sent again under the same id.
 */
export async function syncGatewayRefund(refundId: string): Promise<void> {
  const refund = await loadRefund(refundId);
  if (!refund || refund.status !== 'PROCESSING') return;
  const payment = refund.order.payment;
  const gateway = payment ? providerFor(payment.provider) : null;
  if (!payment?.providerOrderId || !gateway?.fetchRefund) return;
  await prisma.refund.update({ where: { id: refund.id }, data: { lastCheckedAt: new Date() } });
  const answer = await gateway.fetchRefund(payment.providerOrderId, gatewayRefundId(refund));
  if (answer) {
    await applyGatewayAnswer(refund.id, answer);
    return;
  }
  // Never reached the gateway: send it again (same id, same idempotency key).
  const back = await prisma.refund.updateMany({ where: { id: refund.id, status: 'PROCESSING' }, data: { status: 'PENDING' } });
  if (back.count === 1) {
    const fresh = await loadRefund(refund.id);
    if (fresh) await submitToGateway(fresh);
  }
}

/** Our refund behind a gateway refund id (ours, perhaps with an R-suffix). */
export async function refundByGatewayId(gatewayId: string): Promise<string | null> {
  const id = gatewayId.replace(/R\d+$/, '');
  const refund = await prisma.refund.findUnique({ where: { id }, select: { id: true } });
  return refund?.id ?? null;
}

const REFUND_POLL_MS = 15 * 60 * 1000;
/** A refund is asked about at most this often. */
const REFUND_RECHECK_MS = 10 * 60 * 1000;

/** Ask about every PROCESSING gateway refund not asked about lately. */
export async function pollProcessingRefunds(now: Date = new Date()): Promise<number> {
  const stale = new Date(now.getTime() - REFUND_RECHECK_MS);
  const due = await prisma.refund.findMany({
    where: { status: 'PROCESSING', OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: stale } }] },
    select: { id: true },
    orderBy: { submittedAt: 'asc' },
    take: 100,
  });
  for (const r of due) {
    try {
      await syncGatewayRefund(r.id);
    } catch (err) {
      console.error(`[clowe-api] refund poll ${r.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return due.length;
}

export function startRefundPoller(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    pollProcessingRefunds()
      .catch((err) => console.error('[clowe-api] refund poll failed:', err))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, REFUND_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * An admin sends a FAILED gateway refund again. It goes to the gateway as a
 * new refund (its id gets the next R-suffix): the old one was refused, and
 * replaying it would only be refused again.
 */
export async function retryRefund(refundId: string): Promise<{ id: string; status: string }> {
  const refund = await prisma.refund.findUnique({ where: { id: refundId } });
  if (!refund) throw new Error('NOT_FOUND');
  if (refund.provider === MANUAL_COD_PROVIDER) throw new Error('NOT_A_GATEWAY_REFUND');
  if (refund.status !== 'FAILED') throw new Error('NOT_FAILED');
  const reopened = await prisma.refund.updateMany({
    where: { id: refundId, status: 'FAILED' },
    data: { status: 'PENDING', attempts: { increment: 1 }, failureReason: null, providerStatus: null, providerRefundId: null },
  });
  if (reopened.count === 1) await processRefund(refundId);
  return prisma.refund.findUniqueOrThrow({ where: { id: refundId }, select: { id: true, status: true } });
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
    include: { payment: true, refunds: { where: { status: { in: ['PENDING', 'PROCESSING', 'PROCESSED'] } } } },
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
    include: { payment: true, refunds: { where: { status: { in: ['PENDING', 'PROCESSING', 'PROCESSED'] } } } },
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
