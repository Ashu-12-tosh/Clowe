import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { env, webPublicUrl } from '../../env';
import { auditSafe } from '../auditService';
import { settleCreditTopUp } from '../creditTopUps';
import { settlePaymentFailure, settlePaymentSuccess } from '../orderService';
import { refundCancelledOrder } from '../refundService';
import { settlePromotionPurchase } from '../sellerLedgerService';
import { sendToUserSafe } from '../messaging';
import { paymentProvider, providerFor } from './index';
import type { CreateGatewayOrderInput, GatewayOrderState } from './PaymentProvider';

// ---------------------------------------------------------------------------
// Gateway payments after checkout: finding out what happened, and acting on
// it once.
//
// Three things take money through the gateway — orders, shoppers' credit
// top-ups and sellers' wallet top-ups — and all three end the same way: the
// gateway is asked what happened (never the browser, never a webhook's body
// on its own word), and the answer is applied with a conditional update so
// that the browser, the webhook and the sweeper can all arrive at once and
// the effects still happen exactly once.
//
//   PAID       one successful payment, amount and currency as charged
//   ACTIVE     still payable; a failed attempt is not the end — the buyer can
//              try again on the same gateway order until it expires
//   EXPIRED / TERMINATED   can never be paid: the order is cancelled and its
//              stock returned
//
// Money that arrives for an order already cancelled is refunded in full.
// ---------------------------------------------------------------------------

/** How long a gateway order stays payable. */
export const GATEWAY_ORDER_TTL_MIN = 30;
/** For gateways that cannot be asked (mock, Razorpay): give up on an unpaid order after this. */
export const UNASKABLE_ORDER_TTL_MIN = 60;
/** Past expiry, wait this long before stopping an order, for a payment completing at the last moment. */
const EXPIRY_GRACE_MS = 3 * 60 * 1000;

export type PaymentKind = 'ORDER' | 'CREDITS' | 'PROMOTION';

/** Something paid through the gateway, as the sync needs it. */
export interface GatewayTarget {
  kind: PaymentKind;
  /** The order id, or the purchase id. */
  id: string;
  provider: string;
  providerOrderId: string;
  amountPaise: number;
  status: 'CREATED' | 'PAID' | 'FAILED' | 'REFUNDED';
  expiresAt: Date | null;
  createdAt: Date;
  /** The account the money came from (buyer, or the seller's user). */
  userId: string;
  paymentSessionId: string | null;
}

export type ConfirmOutcome = 'PAID' | 'PENDING' | 'RETRY' | 'FAILED';
export interface ConfirmResult {
  outcome: ConfirmOutcome;
  /** For the buyer: why it failed, or what is happening. */
  message?: string;
}

/** Statuses of an attempt that ended without money: the buyer may try again. */
const ENDED_ATTEMPT = new Set(['FAILED', 'USER_DROPPED', 'CANCELLED', 'VOID']);

// ---------------------------------------------------------------------------
// Finding what a gateway order is for
// ---------------------------------------------------------------------------

export async function targetByProviderOrderId(providerOrderId: string): Promise<GatewayTarget | null> {
  const payment = await prisma.payment.findFirst({
    where: { providerOrderId },
    include: { order: { select: { userId: true } } },
  });
  if (payment) {
    return {
      kind: 'ORDER',
      id: payment.orderId,
      provider: payment.provider,
      providerOrderId,
      amountPaise: payment.amountPaise,
      status: payment.status,
      expiresAt: payment.expiresAt,
      createdAt: payment.createdAt,
      userId: payment.order.userId,
      paymentSessionId: payment.paymentSessionId,
    };
  }
  const credit = await prisma.creditPurchase.findFirst({ where: { providerOrderId } });
  if (credit) return creditTarget(credit);
  const promo = await prisma.promotionCreditPurchase.findFirst({
    where: { providerOrderId },
    include: { seller: { select: { userId: true } } },
  });
  if (promo) return promoTarget(promo);
  return null;
}

export async function targetOf(kind: PaymentKind, id: string): Promise<GatewayTarget | null> {
  if (kind === 'ORDER') {
    const payment = await prisma.payment.findUnique({
      where: { orderId: id },
      include: { order: { select: { userId: true } } },
    });
    if (!payment || !payment.providerOrderId) return null;
    return {
      kind,
      id,
      provider: payment.provider,
      providerOrderId: payment.providerOrderId,
      amountPaise: payment.amountPaise,
      status: payment.status,
      expiresAt: payment.expiresAt,
      createdAt: payment.createdAt,
      userId: payment.order.userId,
      paymentSessionId: payment.paymentSessionId,
    };
  }
  if (kind === 'CREDITS') {
    const credit = await prisma.creditPurchase.findUnique({ where: { id } });
    return credit?.providerOrderId ? creditTarget(credit) : null;
  }
  const promo = await prisma.promotionCreditPurchase.findUnique({
    where: { id },
    include: { seller: { select: { userId: true } } },
  });
  return promo?.providerOrderId ? promoTarget(promo) : null;
}

function creditTarget(c: {
  id: string;
  provider: string;
  providerOrderId: string | null;
  amountPaise: number;
  status: 'CREATED' | 'PAID' | 'FAILED';
  expiresAt: Date | null;
  createdAt: Date;
  userId: string;
  paymentSessionId: string | null;
}): GatewayTarget {
  return {
    kind: 'CREDITS',
    id: c.id,
    provider: c.provider,
    providerOrderId: c.providerOrderId ?? '',
    amountPaise: c.amountPaise,
    status: c.status,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    userId: c.userId,
    paymentSessionId: c.paymentSessionId,
  };
}

function promoTarget(p: {
  id: string;
  provider: string;
  providerOrderId: string | null;
  amountPaise: number;
  status: 'CREATED' | 'PAID' | 'FAILED';
  expiresAt: Date | null;
  createdAt: Date;
  seller: { userId: string };
  paymentSessionId: string | null;
}): GatewayTarget {
  return {
    kind: 'PROMOTION',
    id: p.id,
    provider: p.provider,
    providerOrderId: p.providerOrderId ?? '',
    amountPaise: p.amountPaise,
    status: p.status,
    expiresAt: p.expiresAt,
    createdAt: p.createdAt,
    userId: p.seller.userId,
    paymentSessionId: p.paymentSessionId,
  };
}

// ---------------------------------------------------------------------------
// Creating the gateway order
// ---------------------------------------------------------------------------

/** Where Cashfree tells us about payments and refunds; only over https. */
export function gatewayNotifyUrl(): string | undefined {
  const url = `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/api/payments/cashfree/webhook`;
  return url.startsWith('https://') ? url : undefined;
}

/** Where the buyer's browser comes back to after a redirect-style payment. */
export function gatewayReturnUrl(kind: PaymentKind, id: string): string | undefined {
  const base = (webPublicUrl ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return undefined;
  return `${base}/checkout/return?kind=${kind}&id=${encodeURIComponent(id)}`;
}

/** A gateway order for one of our payables, through the active gateway. */
export async function createGatewayOrder(input: {
  kind: PaymentKind;
  id: string;
  receipt: string;
  amountPaise: number;
  customer: CreateGatewayOrderInput['customer'];
  splits?: CreateGatewayOrderInput['splits'];
  note?: string;
}) {
  const expiresAt = new Date(Date.now() + GATEWAY_ORDER_TTL_MIN * 60 * 1000);
  const created = await paymentProvider.createOrder({
    amountPaise: input.amountPaise,
    receipt: input.receipt,
    customer: input.customer,
    returnUrl: gatewayReturnUrl(input.kind, input.id),
    notifyUrl: gatewayNotifyUrl(),
    expiresAt: paymentProvider.name === 'cashfree' ? expiresAt : undefined,
    splits: input.splits,
    note: input.note,
  });
  return {
    providerOrderId: created.providerOrderId,
    paymentSessionId: created.paymentSessionId ?? null,
    // Only a gateway that enforces an expiry gets one recorded; the others are
    // given up on by the sweeper after UNASKABLE_ORDER_TTL_MIN.
    expiresAt: created.paymentSessionId ? (created.expiresAt ?? expiresAt) : null,
  };
}

/**
 * Start the gateway payment for a top-up (a shopper's credits or a seller's
 * wallet). If the gateway cannot be reached the purchase is marked FAILED and
 * the caller gets a 502 the shopper can act on.
 */
export async function startTopUpPayment(input: { kind: 'CREDITS' | 'PROMOTION'; purchaseId: string; amountPaise: number; userId: string }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId }, select: { phone: true, name: true, email: true } });
  const receipt = `${input.kind === 'CREDITS' ? 'CREDITS' : 'PROMO'}-${input.purchaseId}`;
  let gateway: Awaited<ReturnType<typeof createGatewayOrder>>;
  try {
    gateway = await createGatewayOrder({
      kind: input.kind,
      id: input.purchaseId,
      receipt,
      amountPaise: input.amountPaise,
      customer: { id: input.userId, phone: user.phone, name: user.name, email: user.email },
      note: input.kind === 'CREDITS' ? 'Clowe Credits top-up' : 'Clowe Seller Wallet top-up',
    });
  } catch (err) {
    console.error(`[clowe-api] ${receipt}: gateway order failed:`, err instanceof Error ? err.message : err);
    if (input.kind === 'CREDITS') {
      await prisma.creditPurchase.update({ where: { id: input.purchaseId }, data: { status: 'FAILED' } });
    } else {
      await prisma.promotionCreditPurchase.update({ where: { id: input.purchaseId }, data: { status: 'FAILED' } });
    }
    throw new ApiError(502, 'GATEWAY_UNAVAILABLE', 'We could not start the payment just now. Nothing was charged — please try again.');
  }
  const data = { providerOrderId: gateway.providerOrderId, paymentSessionId: gateway.paymentSessionId, expiresAt: gateway.expiresAt };
  if (input.kind === 'CREDITS') await prisma.creditPurchase.update({ where: { id: input.purchaseId }, data });
  else await prisma.promotionCreditPurchase.update({ where: { id: input.purchaseId }, data });
  return checkoutPayload({ provider: paymentProvider.name, providerOrderId: gateway.providerOrderId, paymentSessionId: gateway.paymentSessionId });
}

/** What the browser needs to open (or reopen) the gateway's checkout. */
export function checkoutPayload(target: { provider: string; providerOrderId: string; paymentSessionId: string | null }) {
  return {
    provider: target.provider as 'mock' | 'razorpay' | 'cashfree',
    providerOrderId: target.providerOrderId,
    ...(target.provider === 'razorpay' ? { keyId: paymentProvider.publicKeyId } : {}),
    ...(target.provider === 'cashfree' && target.paymentSessionId
      ? { paymentSessionId: target.paymentSessionId, mode: paymentProvider.mode ?? env.CASHFREE_PG_ENV }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Asking the gateway and acting on the answer
// ---------------------------------------------------------------------------

/**
 * Ask the gateway what happened to this payable and apply it. Safe to call any
 * number of times, from anywhere: the browser after checkout, a webhook, the
 * sweeper. `sweep` lets it stop an order whose time is up.
 */
export async function syncGatewayPayment(target: GatewayTarget, opts: { sweep?: boolean } = {}): Promise<ConfirmResult> {
  if (target.status === 'PAID' || target.status === 'REFUNDED') return { outcome: 'PAID' };

  const provider = providerFor(target.provider);
  if (!provider?.fetchOrder) {
    // Mock and Razorpay settle through their own callbacks; nothing to ask.
    return target.status === 'FAILED' ? { outcome: 'FAILED' } : { outcome: 'PENDING' };
  }

  const state = await provider.fetchOrder(target.providerOrderId);
  if (target.kind === 'ORDER') {
    await prisma.payment.updateMany({ where: { orderId: target.id }, data: { lastCheckedAt: new Date() } });
  }

  const paid = state.attempts.find((a) => a.status === 'SUCCESS');
  if (paid) return applySuccess(target, state, paid.providerPaymentId, paid.amountPaise, paid.currency);
  if (state.status === 'PAID') {
    // Paid with no successful attempt listed yet: the list catches up shortly.
    return { outcome: 'PENDING', message: 'Payment received — confirming it with the bank.' };
  }

  if (state.status === 'EXPIRED' || state.status === 'TERMINATED') {
    if (target.status === 'CREATED') await failTarget(target, 'Payment not completed in time');
    return { outcome: 'FAILED', message: 'This payment was not completed in time. Nothing was charged.' };
  }
  if (target.status === 'FAILED') return { outcome: 'FAILED' };

  // Still payable.
  if (state.attempts.some((a) => a.status === 'PENDING')) {
    return { outcome: 'PENDING', message: 'Your bank has not confirmed the payment yet.' };
  }
  if (opts.sweep && target.expiresAt && target.expiresAt.getTime() + EXPIRY_GRACE_MS < Date.now()) {
    // Stop the gateway order first, so no payment can land after we cancel.
    if (provider.terminateOrder && (await provider.terminateOrder(target.providerOrderId))) {
      await failTarget(target, 'Payment not completed in time');
      return { outcome: 'FAILED', message: 'This payment was not completed in time. Nothing was charged.' };
    }
    return { outcome: 'PENDING' };
  }
  const latest = state.attempts[0];
  if (latest && ENDED_ATTEMPT.has(latest.status)) {
    return {
      outcome: 'RETRY',
      message: latest.status === 'USER_DROPPED' ? 'The payment was not completed.' : (latest.message ?? 'The payment did not go through.'),
    };
  }
  return { outcome: 'PENDING' };
}

async function applySuccess(
  target: GatewayTarget,
  state: GatewayOrderState,
  providerPaymentId: string,
  paidPaise: number,
  currency: string,
): Promise<ConfirmResult> {
  // What was taken must be what was charged, in rupees. A mismatch is never
  // settled automatically: it is logged at the highest severity for a person.
  if (currency !== 'INR' || paidPaise !== target.amountPaise || state.amountPaise !== target.amountPaise) {
    console.error(
      `[clowe-api] payment amount mismatch on ${target.kind} ${target.id}: expected ${target.amountPaise} INR, gateway order ${state.amountPaise} ${state.currency}, payment ${paidPaise} ${currency}`,
    );
    auditSafe({
      actorRole: 'SYSTEM',
      module: 'PAYMENTS',
      action: 'Payment amount mismatch',
      entityType: target.kind === 'ORDER' ? 'Order' : 'Purchase',
      entityId: target.id,
      summary: `Gateway payment ${providerPaymentId} on ${target.providerOrderId} does not match: expected ₹${(target.amountPaise / 100).toFixed(2)} INR, paid ${(paidPaise / 100).toFixed(2)} ${currency}. Not settled.`,
      metadata: { providerOrderId: target.providerOrderId, providerPaymentId, expectedPaise: target.amountPaise, paidPaise, currency, orderPaise: state.amountPaise },
      severity: 'CRITICAL',
      status: 'FAILED',
    });
    return { outcome: 'PENDING', message: 'Your payment is being checked by our team.' };
  }

  if (target.kind === 'CREDITS') {
    await settleCreditTopUp(target.id, providerPaymentId);
    return { outcome: 'PAID' };
  }
  if (target.kind === 'PROMOTION') {
    await settlePromotionPurchase(target.id, providerPaymentId, { allowLate: true });
    return { outcome: 'PAID' };
  }
  const result = await settlePaymentSuccess(target.id, providerPaymentId);
  if (result !== 'LATE') return { outcome: 'PAID' };
  await refundLatePayment(target, providerPaymentId);
  return {
    outcome: 'FAILED',
    message: 'Your payment arrived after this order had been cancelled, so the full amount is being refunded.',
  };
}

/**
 * Money arrived for an order already cancelled for want of payment (the stock
 * went back long ago). Record the payment as taken and refund all of it.
 * Claimed with a conditional update so two webhooks cannot refund twice.
 */
export async function refundLatePayment(target: GatewayTarget, providerPaymentId: string): Promise<void> {
  const claim = await prisma.payment.updateMany({
    where: { orderId: target.id, status: 'FAILED' },
    data: {
      status: 'PAID',
      providerPaymentId,
      paidAt: new Date(),
      failureReason: 'Paid after the order was cancelled — refunded in full',
    },
  });
  if (claim.count === 0) return;
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: target.id },
    select: { orderNumber: true, userId: true, user: { select: { phone: true } } },
  });
  const refund = await refundCancelledOrder(target.id, 'Payment arrived after the order was cancelled');
  auditSafe({
    actorRole: 'SYSTEM',
    module: 'PAYMENTS',
    action: 'Late payment refunded',
    entityType: 'Order',
    entityId: target.id,
    summary: `${order.orderNumber}: ₹${(target.amountPaise / 100).toFixed(2)} arrived after the order was cancelled; refund ${refund?.status ?? 'not created'}`,
    metadata: { providerPaymentId, refundId: refund?.id ?? null, refundStatus: refund?.status ?? null },
    severity: 'HIGH',
  });
  await prisma.notification.create({
    data: {
      userId: order.userId,
      type: 'REFUND_INITIATED',
      title: 'Payment refunded',
      body: `Your payment for ${order.orderNumber} reached us after the order had been cancelled, so we are refunding all ₹${(target.amountPaise / 100).toFixed(2)}. It usually reaches you within 5–7 business days.`,
      linkHref: `/orders/${target.id}`,
    },
  });
  sendToUserSafe(
    order.userId,
    {
      channel: 'whatsapp',
      to: `+91${order.user.phone}`,
      body: `Clowe: your payment for ${order.orderNumber} arrived after the order was cancelled. The full ₹${(target.amountPaise / 100).toFixed(2)} is being refunded.`,
    },
    { critical: true },
  );
}

/** End an unpaid payable: cancel the order (stock back) or fail the purchase. */
async function failTarget(target: GatewayTarget, reason: string): Promise<void> {
  if (target.kind === 'ORDER') {
    await settlePaymentFailure(target.id, reason);
  } else if (target.kind === 'CREDITS') {
    await settleCreditTopUp(target.id, null);
  } else {
    await settlePromotionPurchase(target.id, null, { allowLate: true });
  }
}

// ---------------------------------------------------------------------------
// The sweeper: unpaid gateway orders do not hold stock forever
// ---------------------------------------------------------------------------

const GATEWAYS = ['cashfree', 'razorpay', 'mock'];
const SWEEP_BATCH = 100;
/** A payable is asked about at most this often by the sweeper. */
const RECHECK_MS = 2 * 60 * 1000;

/**
 * Find unpaid gateway orders whose time is up and settle them: ask the
 * gateway when it can be asked (it may have been paid after all), otherwise
 * give up on them after UNASKABLE_ORDER_TTL_MIN. COD and manual orders are
 * never touched — their payment rows wait for the courier or an admin.
 */
export async function sweepUnpaidGatewayPayments(now: Date = new Date()): Promise<{ checked: number; failed: number; paid: number }> {
  const expiredBefore = new Date(now.getTime() - EXPIRY_GRACE_MS);
  const unaskableBefore = new Date(now.getTime() - UNASKABLE_ORDER_TTL_MIN * 60 * 1000);
  const recheckBefore = new Date(now.getTime() - RECHECK_MS);
  const due = {
    status: 'CREATED' as const,
    provider: { in: GATEWAYS },
    OR: [{ expiresAt: { lt: expiredBefore } }, { expiresAt: null, createdAt: { lt: unaskableBefore } }],
  };

  const targets: GatewayTarget[] = [];
  const payments = await prisma.payment.findMany({
    where: { ...due, AND: [{ OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: recheckBefore } }] }] },
    select: { orderId: true },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const p of payments) {
    const t = await targetOf('ORDER', p.orderId);
    if (t) targets.push(t);
  }
  for (const c of await prisma.creditPurchase.findMany({ where: due, select: { id: true }, take: SWEEP_BATCH })) {
    const t = await targetOf('CREDITS', c.id);
    if (t) targets.push(t);
  }
  for (const p of await prisma.promotionCreditPurchase.findMany({ where: due, select: { id: true }, take: SWEEP_BATCH })) {
    const t = await targetOf('PROMOTION', p.id);
    if (t) targets.push(t);
  }

  let failed = 0;
  let paid = 0;
  for (const target of targets) {
    try {
      const provider = providerFor(target.provider);
      if (provider?.fetchOrder) {
        const r = await syncGatewayPayment(target, { sweep: true });
        if (r.outcome === 'FAILED') failed += 1;
        if (r.outcome === 'PAID') paid += 1;
      } else {
        await failTarget(target, 'Payment not completed in time');
        failed += 1;
      }
    } catch (err) {
      // One gateway hiccup must not stop the rest; this one is asked again next run.
      console.error(`[clowe-api] payment sweep: ${target.kind} ${target.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked: targets.length, failed, paid };
}

const SWEEP_EVERY_MS = 5 * 60 * 1000;

export function startPaymentSweeper(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    sweepUnpaidGatewayPayments()
      .then((r) => {
        if (r.failed + r.paid > 0) console.log(`[clowe-api] payment sweep: ${r.paid} paid, ${r.failed} not paid in time (of ${r.checked})`);
      })
      .catch((err) => console.error('[clowe-api] payment sweep failed:', err))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Webhook de-duplication
// ---------------------------------------------------------------------------

/** Whether this provider already delivered (and we handled) this event. */
export async function webhookSeen(provider: string, eventKey: string): Promise<boolean> {
  return (await prisma.gatewayWebhookEvent.count({ where: { provider, eventKey } })) > 0;
}

/** Record a handled event. A concurrent duplicate loses on the unique key, harmlessly. */
export async function recordWebhook(provider: string, eventKey: string, type: string, reference: string | null): Promise<void> {
  await prisma.gatewayWebhookEvent
    .create({ data: { provider, eventKey, type: type.slice(0, 80), reference: reference?.slice(0, 120) ?? null } })
    .catch((err: { code?: string }) => {
      if (err?.code !== 'P2002') throw err;
    });
}
