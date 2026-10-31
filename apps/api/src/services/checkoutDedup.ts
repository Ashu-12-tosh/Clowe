import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { CheckoutResult, PaymentMethod } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { settlePaymentFailure } from './orderService';
import { providerFor } from './payments';
import { checkoutPayload, MIN_SESSION_LEFT_MS, syncGatewayPayment, targetOf } from './payments/gatewaySync';
import { OPEN_ORDER_LOOKBACK_MS, OPEN_ORDER_SETUP_GRACE_MS } from './openOrderHolds';

// ---------------------------------------------------------------------------
// One cart, one payable order (pre-launch test H1/H2).
//
// Two tabs, a refresh, a retry after a lost response or a second press of Pay
// each used to place another order and open another payment, and both could
// be paid. Now checkout first looks, under a per-buyer lock, for the buyer's
// open unpaid order for the same items:
//
// - the same order (same lines, prices, address, total — the fingerprint) is
//   handed back with its existing payment, after asking the gateway whether it
//   was paid meanwhile;
// - a different one (the address or the cart changed) is stopped at the
//   gateway and cancelled before the new order is placed, so its stock is
//   released and it can no longer be paid. If money still lands on it, the
//   late-payment path refunds it in full and alerts the admins.
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

/** An order with no gateway order yet is being set up by another request for this long. */
const SETUP_GRACE_MS = OPEN_ORDER_SETUP_GRACE_MS;
/** Unpaid orders older than this are the sweeper's, not checkout's. */
const LOOKBACK_MS = OPEN_ORDER_LOOKBACK_MS;
/** How long a checkout waits for another checkout of the same buyer to finish. */
export const CHECKOUT_LOCK_WAIT_MS = 8_000;

export interface FingerprintInput {
  lines: { variantId: string; quantity: number; unitPaise: number }[];
  addressId: string;
  billingAddressId: string;
  deliveryMethod: string;
  isGift: boolean;
  giftMessage: string | null;
  buyerGstin: string | null;
  creditsUsed: number;
  couponCode: string | null;
  totalPaise: number;
  cod: boolean;
}

/** What makes two checkouts the same order. */
export function checkoutFingerprint(input: FingerprintInput): string {
  const lines = [...input.lines]
    .sort((a, b) => a.variantId.localeCompare(b.variantId))
    .map((l) => `${l.variantId}:${l.quantity}:${l.unitPaise}`);
  const canonical = JSON.stringify({ ...input, lines });
  return createHash('sha256').update(canonical).digest('hex');
}

export type OpenOrderVerdict =
  /** Nothing open for these items: place the order. `keyFree`: the key may be stored on it. */
  | { kind: 'none'; keyFree: boolean }
  /** Another checkout of this buyer is running: wait (outside the transaction) and try again. */
  | { kind: 'locked' }
  /** Hand this order back instead. */
  | { kind: 'reuse'; orderId: string }
  /** Stop and cancel these orders first, then try again. */
  | { kind: 'replace'; orderIds: string[] }
  /** Another request is still setting up an order for these items. */
  | { kind: 'busy'; orderId: string };

/**
 * Inside the checkout transaction, before anything is reserved: takes the
 * buyer's checkout lock (held until the transaction ends, so two tabs are
 * served one after the other) and decides what to do about orders already open.
 * The lock is only tried, never waited for here: a transaction waiting on it
 * would hold one of the few pool connections the whole time, and a burst of
 * one buyer's clicks could starve every other request.
 */
export async function openOrderFor(
  tx: Tx,
  input: { userId: string; checkoutKey: string | null; fingerprint: string; variantIds: string[]; now?: Date },
): Promise<OpenOrderVerdict> {
  const now = input.now ?? new Date();
  const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`checkout:${input.userId}`})) AS locked`;
  if (!locked) return { kind: 'locked' };

  let keyFree = true;
  if (input.checkoutKey) {
    const keyed = await tx.order.findUnique({
      where: { userId_checkoutKey: { userId: input.userId, checkoutKey: input.checkoutKey } },
      select: { id: true, status: true, paymentMethod: true, checkoutFingerprint: true },
    });
    if (keyed) {
      keyFree = false;
      // The same request again (a retry after a lost answer) for an order that
      // was paid or confirmed meanwhile: that order. One still unpaid is
      // judged below like any open order.
      const settled = keyed.status !== 'PLACED' || keyed.paymentMethod === 'COD';
      if (keyed.checkoutFingerprint === input.fingerprint && keyed.status !== 'CANCELLED' && settled) {
        return { kind: 'reuse', orderId: keyed.id };
      }
    }
  }

  const open = await tx.order.findMany({
    where: {
      userId: input.userId,
      createdAt: { gt: new Date(now.getTime() - LOOKBACK_MS) },
      items: { some: { variantId: { in: input.variantIds } } },
      OR: [
        { status: 'PLACED', paymentMethod: { not: 'COD' } },
        // A COD order is confirmed at once; one placed seconds ago by another tab is this one.
        { paymentMethod: 'COD', status: { not: 'CANCELLED' }, createdAt: { gt: new Date(now.getTime() - SETUP_GRACE_MS) } },
      ],
    },
    select: {
      id: true,
      createdAt: true,
      paymentMethod: true,
      checkoutFingerprint: true,
      payment: { select: { status: true, providerOrderId: true, expiresAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const replace: string[] = [];
  let busy: string | null = null;
  for (const o of open) {
    const same = o.checkoutFingerprint === input.fingerprint;
    if (o.paymentMethod === 'COD') {
      if (same) return { kind: 'reuse', orderId: o.id };
      continue;
    }
    if (!o.payment?.providerOrderId) {
      // Still being set up by another request — or abandoned half-way long
      // ago, which is left to the sweeper rather than blocking this buyer.
      if (now.getTime() - o.createdAt.getTime() > SETUP_GRACE_MS) continue;
      if (same) return { kind: 'reuse', orderId: o.id };
      busy ??= o.id;
      continue;
    }
    if (o.payment.status !== 'CREATED') continue;
    const timeLeft = o.payment.expiresAt ? o.payment.expiresAt.getTime() - now.getTime() : Infinity;
    if (same && timeLeft > MIN_SESSION_LEFT_MS) return { kind: 'reuse', orderId: o.id };
    replace.push(o.id);
  }
  if (busy) return { kind: 'busy', orderId: busy };
  if (replace.length > 0) return { kind: 'replace', orderIds: replace };
  return { kind: 'none', keyFree };
}

export const ALREADY_PAID_MESSAGE = 'This order is already paid — taking you to it.';
export const PAYMENT_PENDING_MESSAGE =
  'A payment for these items is still with your bank. Please do not pay again — we are checking it.';
export const CHECKOUT_BUSY_MESSAGE = 'Your order is still being set up in another tab — please try again in a few seconds.';

const alreadyPaid = (orderId: string) => new ApiError(409, 'ALREADY_PAID', ALREADY_PAID_MESSAGE, undefined, { orderId });
const paymentPending = (orderId: string) => new ApiError(409, 'PAYMENT_PENDING', PAYMENT_PENDING_MESSAGE, undefined, { orderId });
export const checkoutBusy = (orderId?: string) =>
  new ApiError(409, 'CHECKOUT_IN_PROGRESS', CHECKOUT_BUSY_MESSAGE, undefined, orderId ? { orderId } : undefined);

/**
 * Stop older unpaid orders for the same items and cancel them (stock, coupon
 * and credits back). One that turns out to be paid, or that the bank is still
 * deciding, stops the new checkout instead: the buyer is sent to it.
 */
export async function replaceOpenOrders(orderIds: string[]): Promise<void> {
  for (const orderId of orderIds) {
    const target = await targetOf('ORDER', orderId);
    if (target) {
      const provider = providerFor(target.provider);
      if (provider?.fetchOrder) {
        const now = await syncGatewayPayment(target);
        if (now.outcome === 'PAID') throw alreadyPaid(orderId);
        if (now.attemptPending) throw paymentPending(orderId);
        if (now.outcome === 'FAILED') continue;
      }
      // Closed at the gateway first, so nothing can be paid on it once it is cancelled here.
      if (provider?.terminateOrder && !(await provider.terminateOrder(target.providerOrderId))) {
        const fresh = await targetOf('ORDER', orderId);
        const again = fresh ? await syncGatewayPayment(fresh) : null;
        if (again?.outcome === 'PAID') throw alreadyPaid(orderId);
        throw paymentPending(orderId);
      }
    }
    if (!(await settlePaymentFailure(orderId, 'Replaced by a newer checkout'))) {
      // Not cancelled: it was settled meanwhile (a payment that was on its way
      // when the gateway order was stopped). Paid, the buyer goes to it.
      const now = await prisma.payment.findUnique({ where: { orderId }, select: { status: true } });
      if (now?.status === 'PAID' || now?.status === 'REFUNDED') throw alreadyPaid(orderId);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The checkout answer for an order already placed for this cart: its existing
 * payment, if it can still be paid. Null when it is gone (cancelled, expired)
 * and a new order should be placed.
 */
export async function resumeOrder(orderId: string, opts: { waitMs?: number } = {}): Promise<CheckoutResult | null> {
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  for (;;) {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } });
    if (order.status === 'CANCELLED') {
      if (order.payment?.status === 'PAID' || order.payment?.status === 'REFUNDED') throw alreadyPaid(orderId);
      return null;
    }
    if (order.paymentMethod === 'COD') {
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountPaise: order.totalPaise,
        method: order.paymentMethod as PaymentMethod,
        requiresPayment: false,
        payment: { provider: 'cod', providerOrderId: `cod_${order.orderNumber}` },
      };
    }
    if (order.status !== 'PLACED' || order.payment?.status === 'PAID' || order.payment?.status === 'REFUNDED') throw alreadyPaid(orderId);
    if (order.payment?.providerOrderId) break;
    // The request that placed it is still opening the gateway order.
    if (Date.now() > deadline) throw checkoutBusy(orderId);
    await sleep(300);
  }

  const target = await targetOf('ORDER', orderId);
  if (!target) return null;
  const state = await syncGatewayPayment(target);
  if (state.outcome === 'PAID') throw alreadyPaid(orderId);
  if (state.outcome === 'FAILED') return null;
  if (state.attemptPending) throw paymentPending(orderId);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountPaise: order.totalPaise,
    method: order.paymentMethod as PaymentMethod,
    requiresPayment: true,
    payment: checkoutPayload(target),
  };
}
