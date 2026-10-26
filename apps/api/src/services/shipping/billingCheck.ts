import type { DelhiveryBillingLine, Prisma } from '@prisma/client';
import {
  DEFAULT_DELHIVERY_BILLING_COLUMNS,
  DELHIVERY_BILLING_FIELDS,
  DELHIVERY_BILLING_STATUSES,
  delhiveryBillingColumnsSchema,
  parseCsv,
  resolveBillingColumns,
  type DelhiveryBillingCheckListItem,
  type DelhiveryBillingCheckView,
  type DelhiveryBillingColumns,
  type DelhiveryBillingColumnsView,
  type DelhiveryBillingField,
  type DelhiveryBillingKind,
  type DelhiveryBillingLineRow,
  type DelhiveryBillingSellerTotal,
  type DelhiveryBillingStatus,
  type DelhiveryBillingSummary,
  type DelhiveryBillingUploadResult,
} from '@clowe/shared';
import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';
import { postEntry } from '../sellerLedgerService';

// ---------------------------------------------------------------------------
// Delhivery's bill, checked against what sellers were charged.
//
// Each month Delhivery bills Clowe for every parcel it carried: the forward
// trip, the trip back for an undelivered parcel (RTO), and the pickup of a
// customer return (DTO), at the weight it charged. The seller ledger charged
// each seller for the same trips from the charges API (freight.ts). The two
// should agree; this finds where they don't.
//
// An admin uploads the month's billing export as CSV. Each row is matched by
// AWB to our parcel, and each charge on it to what the ledger holds for that
// trip: MATCHED, MISMATCH (amount or weight differs), NOT_ON_LEDGER (our
// parcel, but nothing charged for that trip yet) or UNKNOWN_AWB. Nothing is
// posted by the check. An admin confirms each FREIGHT_ADJUSTMENT, one line at
// a time, and only while the ledger still says what it said at upload.
//
// Delhivery's export format is not documented to us: which column holds what
// is a setting the admin can change, with header guesses until they do.
// ---------------------------------------------------------------------------

export const BILLING_COLUMNS_KEY = 'delhiveryBillingColumns';
/** What our ledger amounts include, and so what a pre-GST bill is raised by when it has no GST column. */
const GST_PERCENT = 18;

type Db = Prisma.TransactionClient | typeof prisma;

/** The mapping in force: what admin saved, over the defaults. */
export async function getBillingColumns(): Promise<DelhiveryBillingColumns> {
  const row = await prisma.platformSetting.findUnique({ where: { key: BILLING_COLUMNS_KEY } });
  if (!row?.value || typeof row.value !== 'object') return DEFAULT_DELHIVERY_BILLING_COLUMNS;
  const parsed = delhiveryBillingColumnsSchema.safeParse({ ...DEFAULT_DELHIVERY_BILLING_COLUMNS, ...(row.value as object) });
  if (!parsed.success) {
    console.error('[clowe-api] stored Delhivery billing columns are invalid; using the defaults');
    return DEFAULT_DELHIVERY_BILLING_COLUMNS;
  }
  return parsed.data;
}

export async function saveBillingColumns(columns: DelhiveryBillingColumns): Promise<DelhiveryBillingColumns> {
  const value = columns as unknown as Prisma.InputJsonValue;
  await prisma.platformSetting.upsert({ where: { key: BILLING_COLUMNS_KEY }, update: { value }, create: { key: BILLING_COLUMNS_KEY, value } });
  return columns;
}

/** The mapping, and the header of the last file uploaded to pick columns from. */
export async function billingColumnsView(): Promise<DelhiveryBillingColumnsView> {
  const [columns, last] = await Promise.all([
    getBillingColumns(),
    prisma.delhiveryBillingCheck.findFirst({ orderBy: { createdAt: 'desc' }, select: { fileName: true, columns: true } }),
  ]);
  return { columns, lastHeaders: last ? storedColumns(last.columns).headers : [], lastFileName: last?.fileName ?? null };
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/** "₹1,234.50" / "1234.5" / "(12.50)" → paise; null when blank or a dash; NaN when it isn't a number. */
export function rupeesToPaise(text: string | undefined): number | null {
  const t = (text ?? '').trim();
  if (t === '' || /^[-–—]$/.test(t)) return null;
  const negative = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[()₹,\s]/g, '').replace(/^(rs\.?|inr)/i, ''));
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round((negative ? -n : n) * 100);
}

/** A weight cell in grams: in the configured unit, unless the cell says "kg" or "g" itself. */
export function weightToGrams(text: string | undefined, unit: DelhiveryBillingColumns['weightUnit']): number | null {
  const t = (text ?? '').trim().toLowerCase();
  if (t === '' || /^[-–—]$/.test(t)) return null;
  const suffix = /kgs?$/.test(t) ? 'KG' : /(g|gm|gms|grams?)$/.test(t) ? 'GRAMS' : unit;
  const n = Number(t.replace(/[a-z,\s]/g, ''));
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(suffix === 'KG' ? n * 1000 : n);
}

/** One row of the file: its charges in paise, GST included, as our ledger's are. */
export interface BillingRow {
  /** Line in the file, the header being line 1. */
  row: number;
  awb: string;
  forwardPaise: number | null;
  rtoPaise: number | null;
  dtoPaise: number | null;
  weightGrams: number | null;
}

export interface BillingFile {
  headers: string[];
  columnsUsed: Record<DelhiveryBillingField, string | null>;
  rows: BillingRow[];
  skipped: { row: number; reason: string }[];
}

/**
 * Share a row's GST across its charges, in proportion, the paise that rounding
 * leaves over going to the last one.
 */
function shareGst(gstPaise: number, amounts: (number | null)[]): (number | null)[] {
  const charged = amounts.filter((a): a is number => a !== null && a !== 0);
  const sum = charged.reduce((s, a) => s + a, 0);
  if (sum === 0) return amounts;
  let left = gstPaise;
  let seen = 0;
  return amounts.map((a) => {
    if (a === null || a === 0) return a;
    seen += 1;
    const share = seen === charged.length ? left : Math.round((gstPaise * a) / sum);
    left -= share;
    return a + share;
  });
}

const quoteList = (headers: string[]) => (headers.length ? headers.map((h) => `"${h}"`).join(', ') : 'none');

/**
 * The billing export, read with the admin's column mapping: a row per AWB with
 * its forward, RTO and return charges. With no forward, RTO or return column,
 * a total column is read as the parcel's one charge. A file with no AWB or no
 * charge column is refused whole, naming the headers it has.
 */
export function readBillingFile(csv: string, columns: DelhiveryBillingColumns): BillingFile {
  const table = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length < 2) throw ApiError.badRequest('The file has no rows under its header', 'EMPTY_REPORT');
  const headers = table[0]!.map((h) => h.trim());
  const at = resolveBillingColumns(headers, columns);
  if (at.awb < 0) {
    throw ApiError.badRequest(
      `Could not find the AWB column. The file's columns are: ${quoteList(headers)}. Choose the AWB column under Column mapping and upload again.`,
      'UNKNOWN_FORMAT',
    );
  }
  const totalOnly = at.forward < 0 && at.rto < 0 && at.dto < 0;
  if (totalOnly && at.total < 0) {
    throw ApiError.badRequest(
      `Could not find a charge column (forward, RTO, return or total). The file's columns are: ${quoteList(headers)}. Choose them under Column mapping and upload again.`,
      'UNKNOWN_FORMAT',
    );
  }
  const columnsUsed = Object.fromEntries(
    DELHIVERY_BILLING_FIELDS.map((f) => [f, at[f] >= 0 ? headers[at[f]]! : null]),
  ) as Record<DelhiveryBillingField, string | null>;
  const forwardAt = totalOnly ? at.total : at.forward;

  const rows: BillingRow[] = [];
  const skipped: BillingFile['skipped'] = [];
  table.slice(1).forEach((cells, i) => {
    const row = i + 2;
    const cell = (index: number) => (index >= 0 ? cells[index] : undefined);
    // Excel keeps a long number as text with a leading apostrophe.
    const awb = (cell(at.awb) ?? '').trim().replace(/^'/, '');
    if (!awb) {
      skipped.push({ row, reason: 'No AWB' });
      return;
    }
    let amounts = [rupeesToPaise(cell(forwardAt)), rupeesToPaise(cell(at.rto)), rupeesToPaise(cell(at.dto))];
    const weightGrams = weightToGrams(cell(at.weight), columns.weightUnit);
    if (amounts.some((a) => Number.isNaN(a)) || Number.isNaN(weightGrams)) {
      skipped.push({ row, reason: `AWB ${awb}: an amount or the weight is not a number` });
      return;
    }
    if (!columns.amountsIncludeGst) {
      if (at.gst >= 0) {
        const gst = rupeesToPaise(cell(at.gst));
        if (Number.isNaN(gst)) {
          skipped.push({ row, reason: `AWB ${awb}: the GST is not a number` });
          return;
        }
        amounts = shareGst(gst ?? 0, amounts);
      } else {
        amounts = amounts.map((a) => (a === null ? null : a + Math.round((a * GST_PERCENT) / 100)));
      }
    }
    const [forwardPaise, rtoPaise, dtoPaise] = amounts as (number | null)[];
    if (!forwardPaise && !rtoPaise && !dtoPaise) {
      skipped.push({ row, reason: `AWB ${awb}: no charge on this row` });
      return;
    }
    rows.push({ row, awb, forwardPaise: forwardPaise ?? null, rtoPaise: rtoPaise ?? null, dtoPaise: dtoPaise ?? null, weightGrams });
  });
  return { headers, columnsUsed, rows, skipped };
}

/** One trip's charge in the bill, all its rows summed. */
export interface BillingCharge {
  awb: string;
  kind: DelhiveryBillingKind;
  billedPaise: number;
  billedWeightGrams: number | null;
}

/**
 * The bill as charges per AWB and trip. A customer return is its own parcel
 * (a REVERSE shipment with its own AWB), so its freight is the return pickup
 * (DTO), whichever column it was billed in. The charged weight belongs to the
 * parcel's own trip — forward, or the pickup for a return. Rows for the same
 * AWB and trip are summed; a trip that sums to nothing is left out.
 */
export function chargesFor(rows: BillingRow[], kindOf: (awb: string) => 'FORWARD' | 'REVERSE' | null): BillingCharge[] {
  const byKey = new Map<string, BillingCharge>();
  const add = (awb: string, kind: DelhiveryBillingKind, paise: number | null, weightGrams: number | null) => {
    if (!paise) return;
    const key = `${awb}\u0000${kind}`;
    const c = byKey.get(key) ?? { awb, kind, billedPaise: 0, billedWeightGrams: null };
    c.billedPaise += paise;
    if (weightGrams !== null) c.billedWeightGrams = Math.max(c.billedWeightGrams ?? 0, weightGrams);
    byKey.set(key, c);
  };
  for (const r of rows) {
    const reverse = kindOf(r.awb) === 'REVERSE';
    add(r.awb, reverse ? 'DTO' : 'FORWARD', r.forwardPaise, r.weightGrams);
    add(r.awb, 'RTO', r.rtoPaise, null);
    add(r.awb, 'DTO', r.dtoPaise, reverse ? r.weightGrams : null);
  }
  return [...byKey.values()].filter((c) => c.billedPaise !== 0);
}

/** What a charge is against the ledger. A weight is compared only when both sides have one. */
export function classifyCharge(input: {
  known: boolean;
  billedPaise: number;
  billedWeightGrams: number | null;
  ledgerPaise: number | null;
  ledgerWeightGrams: number | null;
}): { status: DelhiveryBillingStatus; differencePaise: number } {
  if (!input.known) return { status: 'UNKNOWN_AWB', differencePaise: input.billedPaise };
  if (input.ledgerPaise === null) return { status: 'NOT_ON_LEDGER', differencePaise: input.billedPaise };
  const differencePaise = input.billedPaise - input.ledgerPaise;
  const weightDiffers =
    input.billedWeightGrams !== null && input.ledgerWeightGrams !== null && input.billedWeightGrams !== input.ledgerWeightGrams;
  return { status: differencePaise !== 0 || weightDiffers ? 'MISMATCH' : 'MATCHED', differencePaise };
}

// ---------------------------------------------------------------------------
// What the ledger charged
// ---------------------------------------------------------------------------

const FREIGHT_TYPES = ['FORWARD_FREIGHT', 'FREIGHT_ADJUSTMENT', 'RTO_FREIGHT', 'RETURN_FREIGHT'] as const;
const billingKey = (lineId: string) => `billing-check:${lineId}`;
const chunk = <T>(xs: T[], size = 1000): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/**
 * What the ledger charged each parcel per trip, keyed "<shipmentId>:<kind>"
 * and absent when nothing is posted for it. Forward is the forward freight
 * and every re-pricing of it; RTO and DTO their own entries. An adjustment a
 * billing check posted counts towards the trip its line was for.
 */
export async function ledgerCharges(shipments: { id: string; orderId: string }[], db: Db = prisma): Promise<Map<string, number>> {
  const ids = new Set(shipments.map((s) => s.id));
  const entries: { amountPaise: number; idempotencyKey: string | null }[] = [];
  for (const orderIds of chunk([...new Set(shipments.map((s) => s.orderId))])) {
    entries.push(
      ...(await db.sellerLedgerEntry.findMany({
        where: { orderId: { in: orderIds }, type: { in: [...FREIGHT_TYPES] }, idempotencyKey: { not: null } },
        select: { amountPaise: true, idempotencyKey: true },
      })),
    );
  }
  const lineIds = entries.flatMap((e) => (e.idempotencyKey?.startsWith('billing-check:') ? [e.idempotencyKey.slice('billing-check:'.length)] : []));
  const lineTrip = new Map<string, string>();
  for (const part of chunk(lineIds)) {
    const lines = await db.delhiveryBillingLine.findMany({ where: { id: { in: part } }, select: { id: true, shipmentId: true, kind: true } });
    for (const l of lines) if (l.shipmentId) lineTrip.set(billingKey(l.id), `${l.shipmentId}:${l.kind}`);
  }
  const tripOf = (key: string): string | null => {
    let m: RegExpMatchArray | null;
    if ((m = key.match(/^forward-freight:(.+)$/)) || (m = key.match(/^freight-adjustment:(.+):\d+$/))) return `${m[1]}:FORWARD`;
    if ((m = key.match(/^rto-freight:(.+)$/))) return `${m[1]}:RTO`;
    if ((m = key.match(/^return-freight:(.+)$/))) return `${m[1]}:DTO`;
    return lineTrip.get(key) ?? null;
  };
  const charged = new Map<string, number>();
  for (const e of entries) {
    const trip = tripOf(e.idempotencyKey!);
    if (!trip || !ids.has(trip.slice(0, trip.lastIndexOf(':')))) continue;
    // Seller debits are negative; what they were charged is the opposite.
    charged.set(trip, (charged.get(trip) ?? 0) - e.amountPaise);
  }
  return charged;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

interface StoredColumns {
  mapping: DelhiveryBillingColumns;
  headers: string[];
  used: Record<DelhiveryBillingField, string | null>;
}

function storedColumns(json: Prisma.JsonValue): StoredColumns {
  const v = (json ?? {}) as Partial<StoredColumns>;
  return {
    mapping: { ...DEFAULT_DELHIVERY_BILLING_COLUMNS, ...(v.mapping ?? {}) },
    headers: Array.isArray(v.headers) ? v.headers : [],
    used: (v.used ?? Object.fromEntries(DELHIVERY_BILLING_FIELDS.map((f) => [f, null]))) as StoredColumns['used'],
  };
}

/**
 * Check one month's billing file. Stores the check and a line per AWB and
 * trip, and posts nothing.
 */
export async function createBillingCheck(
  input: { month: string; fileName: string; csv: string },
  adminId: string,
): Promise<DelhiveryBillingUploadResult> {
  const mapping = await getBillingColumns();
  const file = readBillingFile(input.csv, mapping);

  const awbs = [...new Set(file.rows.map((r) => r.awb))];
  const shipments: { id: string; awbNumber: string | null; kind: 'FORWARD' | 'REVERSE'; sellerId: string; orderId: string; freightWeightGrams: number | null }[] = [];
  for (const part of chunk(awbs)) {
    shipments.push(
      ...(await prisma.shipment.findMany({
        where: { awbNumber: { in: part } },
        select: { id: true, awbNumber: true, kind: true, sellerId: true, orderId: true, freightWeightGrams: true },
      })),
    );
  }
  const byAwb = new Map(shipments.map((s) => [s.awbNumber!, s]));
  const charges = chargesFor(file.rows, (awb) => byAwb.get(awb)?.kind ?? null);
  const ledger = await ledgerCharges(shipments);

  const lines = charges.map((c) => {
    const s = byAwb.get(c.awb);
    const ledgerPaise = s ? (ledger.get(`${s.id}:${c.kind}`) ?? null) : null;
    // The weight we charged at is the parcel's own trip's; an RTO is not re-weighed.
    const ledgerWeightGrams = s && c.kind !== 'RTO' ? s.freightWeightGrams : null;
    const { status, differencePaise } = classifyCharge({
      known: !!s,
      billedPaise: c.billedPaise,
      billedWeightGrams: c.billedWeightGrams,
      ledgerPaise,
      ledgerWeightGrams,
    });
    return {
      awbNumber: c.awb,
      kind: c.kind,
      shipmentId: s?.id ?? null,
      sellerId: s?.sellerId ?? null,
      orderId: s?.orderId ?? null,
      billedPaise: c.billedPaise,
      billedWeightGrams: c.billedWeightGrams,
      ledgerPaise,
      ledgerWeightGrams,
      differencePaise,
      status,
    };
  });

  const stored: StoredColumns = { mapping, headers: file.headers, used: file.columnsUsed };
  const check = await prisma.delhiveryBillingCheck.create({
    data: {
      month: input.month,
      fileName: input.fileName,
      uploadedById: adminId,
      columns: stored as unknown as Prisma.InputJsonValue,
      rowCount: file.rows.length + file.skipped.length,
      lines: { createMany: { data: lines } },
    },
  });
  return { ...(await billingCheckView(check.id)), skipped: file.skipped };
}

/** Lines as the admin page shows them, with the seller's shop and the order number. */
async function lineRows(lines: DelhiveryBillingLine[]): Promise<DelhiveryBillingLineRow[]> {
  const sellerIds = [...new Set(lines.flatMap((l) => (l.sellerId ? [l.sellerId] : [])))];
  const orderIds = [...new Set(lines.flatMap((l) => (l.orderId ? [l.orderId] : [])))];
  const shops = new Map<string, string>();
  const orders = new Map<string, string>();
  for (const part of chunk(sellerIds)) {
    for (const s of await prisma.sellerProfile.findMany({ where: { id: { in: part } }, select: { id: true, shopName: true } })) shops.set(s.id, s.shopName);
  }
  for (const part of chunk(orderIds)) {
    for (const o of await prisma.order.findMany({ where: { id: { in: part } }, select: { id: true, orderNumber: true } })) orders.set(o.id, o.orderNumber);
  }
  return lines.map((l) => ({
    id: l.id,
    awbNumber: l.awbNumber,
    kind: l.kind as DelhiveryBillingKind,
    shipmentId: l.shipmentId,
    sellerId: l.sellerId,
    shopName: l.sellerId ? (shops.get(l.sellerId) ?? null) : null,
    orderId: l.orderId,
    orderNumber: l.orderId ? (orders.get(l.orderId) ?? null) : null,
    billedPaise: l.billedPaise,
    billedWeightGrams: l.billedWeightGrams,
    ledgerPaise: l.ledgerPaise,
    ledgerWeightGrams: l.ledgerWeightGrams,
    differencePaise: l.differencePaise,
    status: l.status as DelhiveryBillingStatus,
    adjustmentEntryId: l.adjustmentEntryId,
    adjustedAt: l.adjustedAt?.toISOString() ?? null,
  }));
}

const zeroCounts = () => Object.fromEntries(DELHIVERY_BILLING_STATUSES.map((s) => [s, 0])) as Record<DelhiveryBillingStatus, number>;

/**
 * Totals per seller, largest difference first. The check's own totals are
 * over our parcels only; AWBs that aren't ours are counted, and listed as
 * their own row, but owed by no seller.
 */
export function summarize(lines: DelhiveryBillingLineRow[]): DelhiveryBillingSummary {
  const counts = zeroCounts();
  const sellers = new Map<string, DelhiveryBillingSellerTotal>();
  for (const l of lines) {
    counts[l.status] += 1;
    const key = l.sellerId ?? '';
    const t = sellers.get(key) ?? {
      sellerId: l.sellerId, shopName: l.shopName, lines: 0, mismatched: 0, billedPaise: 0, ledgerPaise: 0, differencePaise: 0, openDifferencePaise: 0,
    };
    t.lines += 1;
    if (l.status !== 'MATCHED') t.mismatched += 1;
    t.billedPaise += l.billedPaise;
    t.ledgerPaise += l.ledgerPaise ?? 0;
    t.differencePaise += l.differencePaise;
    if (!l.adjustedAt) t.openDifferencePaise += l.differencePaise;
    sellers.set(key, t);
  }
  const ours = [...sellers.values()].filter((t) => t.sellerId !== null);
  const sum = (pick: (t: DelhiveryBillingSellerTotal) => number) => ours.reduce((s, t) => s + pick(t), 0);
  return {
    counts,
    billedPaise: sum((t) => t.billedPaise),
    ledgerPaise: sum((t) => t.ledgerPaise),
    differencePaise: sum((t) => t.differencePaise),
    sellers: [...sellers.values()].sort(
      (a, b) => Number(a.sellerId === null) - Number(b.sellerId === null) || Math.abs(b.differencePaise) - Math.abs(a.differencePaise),
    ),
  };
}

/** One check: its summary over every line, and the lines a filter picks. */
export async function billingCheckView(
  checkId: string,
  filter: { status?: DelhiveryBillingStatus; sellerId?: string } = {},
): Promise<DelhiveryBillingCheckView> {
  const check = await prisma.delhiveryBillingCheck.findUnique({ where: { id: checkId } });
  if (!check) throw ApiError.notFound('Billing check not found');
  const all = await lineRows(
    await prisma.delhiveryBillingLine.findMany({ where: { checkId }, orderBy: [{ sellerId: 'asc' }, { awbNumber: 'asc' }, { kind: 'asc' }] }),
  );
  const stored = storedColumns(check.columns);
  return {
    id: check.id,
    month: check.month,
    fileName: check.fileName,
    rowCount: check.rowCount,
    createdAt: check.createdAt.toISOString(),
    headers: stored.headers,
    columnsUsed: stored.used,
    columns: stored.mapping,
    summary: summarize(all),
    lines: all.filter((l) => (!filter.status || l.status === filter.status) && (!filter.sellerId || l.sellerId === filter.sellerId)),
  };
}

/** Checks uploaded, newest first, with their counts and the difference on our parcels. */
export async function listBillingChecks(take = 50): Promise<DelhiveryBillingCheckListItem[]> {
  const checks = await prisma.delhiveryBillingCheck.findMany({ orderBy: { createdAt: 'desc' }, take });
  if (checks.length === 0) return [];
  const groups = await prisma.delhiveryBillingLine.groupBy({
    by: ['checkId', 'status'],
    where: { checkId: { in: checks.map((c) => c.id) } },
    _count: { _all: true },
  });
  const ours = await prisma.delhiveryBillingLine.groupBy({
    by: ['checkId'],
    where: { checkId: { in: checks.map((c) => c.id) }, sellerId: { not: null } },
    _sum: { differencePaise: true },
  });
  return checks.map((c) => {
    const counts = zeroCounts();
    for (const g of groups) if (g.checkId === c.id) counts[g.status as DelhiveryBillingStatus] = g._count._all;
    return {
      id: c.id,
      month: c.month,
      fileName: c.fileName,
      rowCount: c.rowCount,
      createdAt: c.createdAt.toISOString(),
      counts,
      differencePaise: ours.find((o) => o.checkId === c.id)?._sum.differencePaise ?? 0,
    };
  });
}

const KIND_WORDS: Record<DelhiveryBillingKind, string> = { FORWARD: 'forward', RTO: 'RTO', DTO: 'return pickup' };
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

/**
 * Post the difference on one line to its seller's ledger as a freight
 * adjustment — only on an admin's confirmed request, once per line, and only
 * while the ledger still holds what the check compared against (an upload
 * of the same AWB adjusted since, or freight posted since, refuses it: check
 * the file again). A trip not charged yet is charged the whole bill.
 */
export async function adjustBillingLine(lineId: string, adminId: string): Promise<{ line: DelhiveryBillingLineRow; entryId: string; month: string }> {
  const line = await prisma.delhiveryBillingLine.findUnique({ where: { id: lineId }, include: { check: { select: { month: true } } } });
  if (!line) throw ApiError.notFound('Billing line not found');
  if (line.status === 'UNKNOWN_AWB' || !line.shipmentId || !line.sellerId) {
    throw ApiError.badRequest('This AWB is not one of our parcels: there is no seller to adjust', 'UNKNOWN_AWB');
  }
  if (line.adjustedAt) throw ApiError.badRequest('This line is already adjusted', 'ALREADY_ADJUSTED');
  if (line.differencePaise === 0) throw ApiError.badRequest('Nothing to adjust: the amounts agree', 'NOTHING_TO_ADJUST');
  const shipment = await prisma.shipment.findUnique({
    where: { id: line.shipmentId },
    select: { id: true, orderId: true, sellerId: true, order: { select: { orderNumber: true } } },
  });
  if (!shipment) throw ApiError.badRequest('The parcel is no longer on record', 'UNKNOWN_AWB');

  const key = billingKey(line.id);
  const entryId = await prisma.$transaction(async (tx) => {
    // One adjustment of a parcel at a time, so two checks can't both act on the same ledger figure.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-check:${shipment.id}`}))`;
    const fresh = await tx.delhiveryBillingLine.findUniqueOrThrow({ where: { id: line.id }, select: { adjustedAt: true } });
    if (fresh.adjustedAt) throw ApiError.badRequest('This line is already adjusted', 'ALREADY_ADJUSTED');
    const now = (await ledgerCharges([shipment], tx)).get(`${shipment.id}:${line.kind}`) ?? null;
    if (now !== line.ledgerPaise) {
      throw ApiError.badRequest(
        `The ledger for this parcel has changed since the file was checked (it now has ${now === null ? 'nothing' : rupees(now)}). Upload the file again to check it afresh.`,
        'LEDGER_CHANGED',
      );
    }
    await postEntry(
      {
        sellerId: line.sellerId!,
        type: 'FREIGHT_ADJUSTMENT',
        bucket: 'SETTLEMENT',
        amountPaise: -line.differencePaise,
        orderId: shipment.orderId,
        idempotencyKey: key,
        createdById: adminId,
        note: `Delhivery billing check ${line.check.month}: AWB ${line.awbNumber} ${KIND_WORDS[line.kind as DelhiveryBillingKind]}, ${shipment.order.orderNumber}, billed ${rupees(line.billedPaise)} vs charged ${rupees(line.ledgerPaise ?? 0)}`,
      },
      tx,
    );
    const entry = await tx.sellerLedgerEntry.findUniqueOrThrow({ where: { idempotencyKey: key }, select: { id: true } });
    // The trip now stands charged at Delhivery's bill: freight.ts reads these,
    // so a parcel adjusted before it was delivered (or returned) is not charged
    // the trip again then, and a later re-weigh re-prices from the bill.
    await tx.shipment.update({
      where: { id: shipment.id },
      data:
        line.kind === 'RTO'
          ? { rtoFreightPaise: line.billedPaise }
          : { finalFreightPaise: line.billedPaise, ...(line.billedWeightGrams ? { freightWeightGrams: line.billedWeightGrams } : {}) },
    });
    await tx.delhiveryBillingLine.update({ where: { id: line.id }, data: { adjustmentEntryId: entry.id, adjustedAt: new Date(), adjustedById: adminId } });
    return entry.id;
  });
  const [row] = await lineRows([await prisma.delhiveryBillingLine.findUniqueOrThrow({ where: { id: line.id } })]);
  return { line: row!, entryId, month: line.check.month };
}
