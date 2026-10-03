import type { PlatformSettings } from '@clowe/shared';
import {
  dispatchSlaDeadline,
  isOrderDispatchLate,
  lateDispatchNote,
  penaltyDeadline,
  type DispatchLine,
  type SellerDispatchClock,
  type VacationSpan,
} from '@clowe/shared';
import { prisma } from '../db';
import { getSettings } from './settingsService';
import { latePenaltyKey, postEntry } from './sellerLedgerService';

// ---------------------------------------------------------------------------
// The late-dispatch penalty.
//
// One penalty per order and seller, posted when the deadline
// (lateDispatchPenaltyAfterHours after placement) passes with the seller's
// part of the order not yet dispatched. The sweep below charges it on time
// even when the seller never ships; shipping late charges it too, in case the
// sweep has not run yet. Either way the ledger's idempotency key lets it land
// once. Vacation mode stops the clock (penaltyDeadline).
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const AWAITING_DISPATCH = new Set(['CONFIRMED', 'PACKED']);

/** How often the sweep looks for orders whose deadline has passed. */
export const LATE_DISPATCH_SWEEP_MS = 5 * 60_000;

interface SellerVacation {
  vacationMode: boolean;
  vacationStartedAt: Date | null;
  vacationEndedAt: Date | null;
}

/** The seller's latest vacation, open-ended while it is still on. */
export function vacationSpan(seller: SellerVacation): VacationSpan | null {
  if (seller.vacationMode) return { startedAt: seller.vacationStartedAt ?? new Date(0), endedAt: null };
  if (!seller.vacationStartedAt) return null;
  return { startedAt: seller.vacationStartedAt, endedAt: seller.vacationEndedAt };
}

const VACATION_SELECT = { vacationMode: true, vacationStartedAt: true, vacationEndedAt: true } as const;

/**
 * Charge the penalty for this seller's part of the order if it is due at
 * `now`. Returns true only when a penalty was posted by this call. An order
 * that already carries one (including a per-line penalty from before the
 * per-order rule) is never charged again.
 */
export async function chargeLateDispatchIfDue(orderId: string, sellerId: string, now = new Date()): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.penaltyEnabled || settings.lateDispatchPenaltyPaise <= 0) return false;

  const [order, seller, already] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: { createdAt: true, items: { where: { sellerId }, select: { status: true, shippedAt: true } } },
    }),
    prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: VACATION_SELECT }),
    prisma.sellerLedgerEntry.count({ where: { sellerId, orderId, type: 'LATE_DISPATCH_PENALTY' } }),
  ]);
  if (!order || !seller || already > 0 || order.items.length === 0) return false;

  const afterHours = settings.lateDispatchPenaltyAfterHours;
  const deadline = penaltyDeadline(order.createdAt, afterHours, vacationSpan(seller));
  if (!deadline || !isOrderDispatchLate(order.items, deadline, now)) return false;

  // The note names when the last line left, or that one never did.
  const owed = order.items.filter((l) => l.status !== 'CANCELLED' && l.status !== 'PLACED');
  const allLeft = owed.every((l) => l.shippedAt);
  const lastLeft = allLeft ? new Date(Math.max(...owed.map((l) => l.shippedAt!.getTime()))) : null;
  const pausedHours = (deadline.getTime() - order.createdAt.getTime()) / HOUR_MS - afterHours;

  return postEntry({
    sellerId,
    type: 'LATE_DISPATCH_PENALTY',
    bucket: 'SETTLEMENT',
    amountPaise: -settings.lateDispatchPenaltyPaise,
    orderId,
    idempotencyKey: latePenaltyKey(orderId, sellerId),
    note: lateDispatchNote({ placedAt: order.createdAt, shippedAt: lastLeft, afterHours, pausedHours }),
  });
}

/**
 * Charge every order whose deadline has passed with something still to
 * dispatch. Orders placed within the last afterHours cannot be due yet
 * (vacation only moves deadlines later), so only older ones are looked at.
 */
export async function sweepLateDispatch(now = new Date()): Promise<number> {
  const settings = await getSettings();
  if (!settings.penaltyEnabled || settings.lateDispatchPenaltyPaise <= 0) return 0;
  const cutoff = new Date(now.getTime() - settings.lateDispatchPenaltyAfterHours * HOUR_MS);
  const pairs = await prisma.orderItem.findMany({
    where: { status: { in: ['CONFIRMED', 'PACKED'] }, order: { createdAt: { lt: cutoff } } },
    select: { orderId: true, sellerId: true },
    distinct: ['orderId', 'sellerId'],
  });
  let charged = 0;
  for (const p of pairs) {
    if (await chargeLateDispatchIfDue(p.orderId, p.sellerId, now)) charged += 1;
  }
  return charged;
}

/** Run once at boot, then every few minutes. Failures are logged, never fatal. */
export function startLateDispatchJob(): void {
  const run = () => {
    sweepLateDispatch()
      .then((n) => {
        if (n > 0) console.log(`[clowe-api] late-dispatch penalties charged: ${n}`);
      })
      .catch((err) => console.error('[clowe-api] late-dispatch sweep failed:', err));
  };
  run();
  const timer = setInterval(run, LATE_DISPATCH_SWEEP_MS);
  timer.unref();
}

/**
 * The promise and penalty clocks for a seller's order, or null when nothing
 * is left to dispatch.
 */
export function dispatchClock(input: {
  placedAt: Date;
  lines: DispatchLine[];
  settings: Pick<
    PlatformSettings,
    'dispatchSlaHours' | 'lateDispatchPenaltyAfterHours' | 'penaltyEnabled'
  >;
  vacation: VacationSpan | null;
  penaltyCharged: boolean;
}): SellerDispatchClock | null {
  if (!input.lines.some((l) => AWAITING_DISPATCH.has(l.status))) return null;
  const { settings } = input;
  const deadline = penaltyDeadline(input.placedAt, settings.lateDispatchPenaltyAfterHours, input.vacation);
  return {
    dispatchBy: dispatchSlaDeadline(input.placedAt, settings.dispatchSlaHours).toISOString(),
    penaltyAt: settings.penaltyEnabled && deadline ? deadline.toISOString() : null,
    penaltyEnabled: settings.penaltyEnabled,
    penaltyPaused: settings.penaltyEnabled && deadline === null,
    penaltyCharged: input.penaltyCharged,
  };
}

/** What toRow needs to give each of a seller's orders its clocks. */
export interface DispatchContext {
  settings: PlatformSettings;
  vacation: VacationSpan | null;
  penalized: Set<string>;
}

export async function dispatchContext(sellerId: string, orderIds: string[]): Promise<DispatchContext> {
  const [settings, seller, penalties] = await Promise.all([
    getSettings(),
    prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: VACATION_SELECT }),
    orderIds.length
      ? prisma.sellerLedgerEntry.findMany({
          where: { sellerId, orderId: { in: orderIds }, type: 'LATE_DISPATCH_PENALTY' },
          select: { orderId: true },
        })
      : [],
  ]);
  return {
    settings,
    vacation: seller ? vacationSpan(seller) : null,
    penalized: new Set(penalties.map((p) => p.orderId!).filter(Boolean)),
  };
}
