import { Prisma, type SellerLedgerBucket, type SellerLedgerType } from '@prisma/client';
import {
  computeListingEconomics,
  isLateDispatch,
  lateDispatchNote,
  type SellerLedgerEntryRow,
  type SellerLedgerPage,
  type SellerLedgerTypeValue,
} from '@clowe/shared';
import { prisma } from '../db';
import { getSettings } from './settingsService';

// ---------------------------------------------------------------------------
// The seller ledger.
//
// Balances are sums over seller_ledger_entries, never a stored number, so a
// crashed request or a racing one cannot leave a balance that disagrees with
// its history. Posting is idempotent by shape: the unique pairs on the table
// ((orderItemId, type), (payoutId, type), (adId, type)) are what stop a
// delivery, a penalty or a payout landing twice, and every poster here uses
// createMany with skipDuplicates so a replay is a no-op rather than an error.
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Entries a delivery produces. These are the ones the return window applies
 * to: they count towards the balance at once, but towards the *available*
 * balance only once the line has cleared the hold.
 */
export const DELIVERY_ENTRY_TYPES: readonly SellerLedgerTypeValue[] = [
  'SALE_EARNING',
  'COMMISSION',
  'PLATFORM_FEE',
  'GATEWAY_FEE',
  'TDS',
];

export interface PostEntryInput {
  sellerId: string;
  type: SellerLedgerType;
  bucket: SellerLedgerBucket;
  amountPaise: number;
  orderId?: string | null;
  orderItemId?: string | null;
  payoutId?: string | null;
  adId?: string | null;
  note?: string | null;
  createdById?: string | null;
}

/**
 * Post one entry. Returns true when it was written, false when the unique
 * pair says it already exists — the caller decides whether "already posted"
 * is fine (a replayed delivery) or a conflict (waiving a penalty twice).
 */
export async function postEntry(input: PostEntryInput, db: Db = prisma): Promise<boolean> {
  const { count } = await db.sellerLedgerEntry.createMany({
    data: [toRow(input)],
    skipDuplicates: true,
  });
  return count === 1;
}

function toRow(input: PostEntryInput): Prisma.SellerLedgerEntryCreateManyInput {
  return {
    sellerId: input.sellerId,
    type: input.type,
    bucket: input.bucket,
    amountPaise: input.amountPaise,
    orderId: input.orderId ?? null,
    orderItemId: input.orderItemId ?? null,
    payoutId: input.payoutId ?? null,
    adId: input.adId ?? null,
    note: input.note ?? null,
    createdById: input.createdById ?? null,
  };
}

/** Sum of one bucket. The seller's balance, full stop. */
export async function balance(
  sellerId: string,
  bucket: SellerLedgerBucket,
  db: Db = prisma,
): Promise<number> {
  const agg = await db.sellerLedgerEntry.aggregate({
    where: { sellerId, bucket },
    _sum: { amountPaise: true },
  });
  return agg._sum.amountPaise ?? 0;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Post the earning and its deductions for one delivered line, from the shared
 * calculator so the ledger, the payout page and the product form can never
 * disagree. Safe to call any number of times: the (orderItemId, type) unique
 * pair makes every call after the first a no-op.
 *
 * Zero-amount deductions (a rate set to 0%) are not written — an empty row
 * explains nothing to the seller.
 */
export async function postDeliveryEntries(orderItemId: string, db: Db = prisma): Promise<number> {
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, orderId: true, sellerId: true, pricePaise: true, quantity: true, status: true },
  });
  if (!item || item.status !== 'DELIVERED') return 0;

  const settings = await getSettings();
  const economics = computeListingEconomics({
    sellerPricePaise: item.pricePaise,
    quantity: item.quantity,
    rates: {
      commissionPercent: settings.payoutCommissionPercent,
      gatewayPercent: settings.payoutGatewayPercent,
      tdsPercent: settings.payoutTdsPercent,
    },
  });

  const rows = economics.lines
    .filter((l) => l.ledgerType !== null && l.amountPaise !== 0)
    .map((l) =>
      toRow({
        sellerId: item.sellerId,
        type: l.ledgerType as SellerLedgerType,
        bucket: 'SETTLEMENT',
        amountPaise: l.amountPaise,
        orderId: item.orderId,
        orderItemId: item.id,
        note: l.label,
      }),
    );
  if (rows.length === 0) return 0;
  const { count } = await db.sellerLedgerEntry.createMany({ data: rows, skipDuplicates: true });
  return count;
}

/**
 * A delivered line that came back: undo what its delivery posted, in one
 * entry, so the balance returns to exactly where it was. If the money has
 * already been paid out this drives the balance negative and the next payout
 * recovers it. Lines delivered before the ledger existed have nothing to
 * undo and post nothing.
 */
export async function postReturnReversal(orderItemId: string, db: Db = prisma): Promise<boolean> {
  const posted = await db.sellerLedgerEntry.aggregate({
    where: { orderItemId, bucket: 'SETTLEMENT', type: { in: [...DELIVERY_ENTRY_TYPES] } },
    _sum: { amountPaise: true },
  });
  const net = posted._sum.amountPaise ?? 0;
  if (net === 0) return false;
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { sellerId: true, orderId: true, title: true },
  });
  if (!item) return false;
  return postEntry(
    {
      sellerId: item.sellerId,
      type: 'RETURN_REVERSAL',
      bucket: 'SETTLEMENT',
      amountPaise: -net,
      orderId: item.orderId,
      orderItemId,
      note: `Returned: "${item.title}" — sale and its deductions reversed`,
    },
    db,
  );
}

/**
 * Lines delivered before the ledger existed (or before this seller's first
 * read) have no entries yet. Post them now, at the rates in force now — the
 * one place the ledger can differ from what the delivery-time rates would
 * have said, and only for history. Nothing is posted for lines already paid
 * out: their money has left, and a late entry would count it twice.
 */
export async function ensureLedgerCoversDeliveries(sellerId: string, db: Db = prisma): Promise<number> {
  const missing = await db.orderItem.findMany({
    where: {
      sellerId,
      status: 'DELIVERED',
      payoutId: null,
      ledgerEntries: { none: { type: 'SALE_EARNING' } },
    },
    select: { id: true },
  });
  let posted = 0;
  for (const item of missing) posted += await postDeliveryEntries(item.id, db);
  return posted;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Charge the late-dispatch penalty if this line shipped after its window.
 * Judged on the order's placement time and the line's own shippedAt, so the
 * same answer comes out whichever path marked it shipped. Returns true only
 * when a penalty was posted now; a replay finds the (orderItemId, type) pair
 * already taken and posts nothing. With penalties switched off nothing is
 * posted and nothing already posted is touched.
 */
export async function postLateDispatchPenalty(orderItemId: string, db: Db = prisma): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.penaltyEnabled || settings.lateDispatchPenaltyPaise <= 0) return false;

  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      sellerId: true,
      orderId: true,
      shippedAt: true,
      order: { select: { createdAt: true } },
    },
  });
  if (!item?.shippedAt) return false;
  if (!isLateDispatch(item.order.createdAt, item.shippedAt, settings.dispatchWindowHours)) return false;

  return postEntry(
    {
      sellerId: item.sellerId,
      type: 'LATE_DISPATCH_PENALTY',
      bucket: 'SETTLEMENT',
      amountPaise: -settings.lateDispatchPenaltyPaise,
      orderId: item.orderId,
      orderItemId,
      note: lateDispatchNote(item.order.createdAt, item.shippedAt, settings.dispatchWindowHours),
    },
    db,
  );
}

export type WaiveOutcome = 'WAIVED' | 'ALREADY_WAIVED' | 'NOT_A_PENALTY';

/**
 * Forgive one penalty: post the opposite amount against the same line. The
 * (orderItemId, PENALTY_WAIVER) pair means a line can be forgiven once,
 * however many admins click.
 */
export async function waivePenalty(
  entryId: string,
  sellerId: string,
  adminId: string,
  reason: string,
  db: Db = prisma,
): Promise<{ outcome: WaiveOutcome; amountPaise: number; orderItemId: string | null }> {
  const entry = await db.sellerLedgerEntry.findFirst({ where: { id: entryId, sellerId } });
  if (!entry || entry.type !== 'LATE_DISPATCH_PENALTY' || !entry.orderItemId) {
    return { outcome: 'NOT_A_PENALTY', amountPaise: 0, orderItemId: null };
  }
  const posted = await postEntry(
    {
      sellerId,
      type: 'PENALTY_WAIVER',
      bucket: 'SETTLEMENT',
      amountPaise: -entry.amountPaise,
      orderId: entry.orderId,
      orderItemId: entry.orderItemId,
      note: `Waived: ${reason}`,
      createdById: adminId,
    },
    db,
  );
  return {
    outcome: posted ? 'WAIVED' : 'ALREADY_WAIVED',
    amountPaise: -entry.amountPaise,
    orderItemId: entry.orderItemId,
  };
}

// ---------------------------------------------------------------------------
// Settlement position
// ---------------------------------------------------------------------------

export interface SettlementPosition {
  /** Everything in the settlement bucket, cleared or not. */
  balancePaise: number;
  /** What a payout could transfer right now. */
  availablePaise: number;
  /** Delivery entries still inside the return window. */
  clearingPaise: number;
}

/**
 * The settlement bucket split into cleared and clearing. A delivery's entries
 * clear when the line's deliveredAt is older than the hold; everything else
 * (penalties, waivers, payouts, reversals, adjustments) counts at once.
 * Judged on the line's own delivery date rather than the entry's timestamp so
 * a lazily backfilled entry clears on the same day a prompt one would have.
 */
export async function settlementPosition(
  sellerId: string,
  holdDays: number,
  db: Db = prisma,
): Promise<SettlementPosition> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - holdDays);
  const rows = await db.$queryRaw<{ balance: number; available: number }[]>(Prisma.sql`
    SELECT
      COALESCE(SUM(e."amountPaise"), 0)::int AS balance,
      COALESCE(SUM(
        CASE
          WHEN e.type::text IN (${Prisma.join([...DELIVERY_ENTRY_TYPES])})
           AND i."deliveredAt" > ${cutoff}
          THEN 0
          ELSE e."amountPaise"
        END
      ), 0)::int AS available
    FROM seller_ledger_entries e
    LEFT JOIN order_items i ON i.id = e."orderItemId"
    WHERE e."sellerId" = ${sellerId} AND e.bucket = 'SETTLEMENT'::"SellerLedgerBucket"
  `);
  const row = rows[0] ?? { balance: 0, available: 0 };
  return {
    balancePaise: row.balance,
    availablePaise: row.available,
    clearingPaise: row.balance - row.available,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

interface HistoryRow {
  id: string;
  type: SellerLedgerType;
  bucket: SellerLedgerBucket;
  amountPaise: number;
  note: string | null;
  orderItemId: string | null;
  payoutId: string | null;
  adId: string | null;
  createdAt: Date;
  running: number;
}

/**
 * Newest first, with the balance after each row. The running figure is a
 * window sum over the whole bucket, computed by the database on every read —
 * there is no stored balance to fall out of step with the rows.
 */
export async function history(
  sellerId: string,
  bucket: SellerLedgerBucket,
  page: number,
  pageSize: number,
  db: Db = prisma,
): Promise<SellerLedgerPage> {
  const [total, balancePaise, rows] = await Promise.all([
    db.sellerLedgerEntry.count({ where: { sellerId, bucket } }),
    balance(sellerId, bucket, db),
    db.$queryRaw<HistoryRow[]>(Prisma.sql`
      SELECT
        e.id, e.type, e.bucket, e."amountPaise", e.note, e."orderItemId", e."payoutId", e."adId",
        e."createdAt",
        SUM(e."amountPaise") OVER (
          ORDER BY e."createdAt", e.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::int AS running
      FROM seller_ledger_entries e
      WHERE e."sellerId" = ${sellerId} AND e.bucket = ${bucket}::"SellerLedgerBucket"
      ORDER BY e."createdAt" DESC, e.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
  ]);

  const itemIds = rows.map((r) => r.orderItemId).filter((id): id is string => !!id);
  const payoutIds = rows.map((r) => r.payoutId).filter((id): id is string => !!id);
  const [items, payouts] = await Promise.all([
    itemIds.length
      ? db.orderItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, title: true, order: { select: { orderNumber: true } } },
        })
      : [],
    payoutIds.length
      ? db.payout.findMany({ where: { id: { in: payoutIds } }, select: { id: true, reference: true } })
      : [],
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const payoutById = new Map(payouts.map((p) => [p.id, p]));

  const out: SellerLedgerEntryRow[] = rows.map((r) => {
    const item = r.orderItemId ? itemById.get(r.orderItemId) : undefined;
    return {
      id: r.id,
      type: r.type,
      bucket: r.bucket,
      amountPaise: r.amountPaise,
      runningBalancePaise: r.running,
      note: r.note,
      reference: {
        orderNumber: item?.order.orderNumber ?? null,
        orderItemId: r.orderItemId,
        itemTitle: item?.title ?? null,
        payoutReference: r.payoutId ? (payoutById.get(r.payoutId)?.reference ?? null) : null,
        adId: r.adId,
      },
      createdAt: r.createdAt.toISOString(),
    };
  });

  return {
    bucket,
    balancePaise,
    rows: out,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
