import {
  CLOWE_CHARGE_TYPES,
  istMonthBounds,
  istMonthOf,
  SELLER_LEDGER_TYPE_LABELS,
  type SellerInvoiceLine,
  type SellerInvoiceListRow,
  type SellerLedgerTypeValue,
  type SellerMonthlyInvoice,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { getCommercial } from './commercial';
import { getSettings } from './settingsService';

// ---------------------------------------------------------------------------
// Clowe's monthly tax invoice to a seller (owner's Batch 2). Built from the
// ledger: every Clowe charge posted in the India-time month (advertising
// paid with advertising credit is not consideration, so it is left out), the
// GST posted with it, and — as a credit — the order fees reversed on returns
// in the month. Issued once the month ends; numbered per financial year.
// ---------------------------------------------------------------------------

const ORDER_FEE_TYPES: SellerLedgerTypeValue[] = ['COMMISSION', 'GT_CHARGE', 'GATEWAY_FEE', 'HANDLING_FEE', 'PLATFORM_FEE', 'CLOSING_FEE'];
const LABELS: Partial<Record<SellerLedgerTypeValue, string>> = {
  COMMISSION: 'Referral fee',
  GATEWAY_FEE: 'Payment collection fee',
  GT_CHARGE: 'GT charge',
  HANDLING_FEE: 'Handling fee',
  PLATFORM_FEE: 'Platform fee (orders before the current fees)',
  CLOSING_FEE: 'Closing fee (orders before the current fees)',
};

/** Spread a GST total over lines in proportion to their taxable values, to the paisa. */
function spread(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || weights.length === 0) return weights.map(() => 0);
  const out = weights.map((w) => Math.round((total * w) / sum));
  // Whatever rounding left over goes on the biggest line, so the parts add up to the total.
  const biggest = weights.reduce((best, w, i) => (Math.abs(w) > Math.abs(weights[best]!) ? i : best), 0);
  out[biggest]! += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/** Penalties carry GST from Batch 2 on; each is its own invoice line. */
const PENALTY_INVOICE_TYPES = ['LATE_DISPATCH_PENALTY', 'ADMIN_PENALTY'] as const;

export async function buildMonthlyInvoice(sellerId: string, month: string): Promise<SellerMonthlyInvoice> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw ApiError.badRequest('Month looks like 2026-10');
  const [seller, settings, c] = await Promise.all([
    prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } }),
    getSettings(),
    getCommercial(),
  ]);
  const { from, to } = istMonthBounds(month);
  const rows = await prisma.sellerLedgerEntry.findMany({
    where: { sellerId, createdAt: { gte: from, lt: to }, bucket: { not: 'AD_CREDIT' } },
    select: { type: true, amountPaise: true, chargeType: true, orderItemId: true, taxablePaise: true },
  });

  // Charges and their GST, per charge type (order fees grouped for the GST).
  const taxable = new Map<SellerLedgerTypeValue, number>();
  const gstByGroup = new Map<string, number>();
  const penaltyBase = new Map<string, number>();
  const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const r of rows) {
    if ((CLOWE_CHARGE_TYPES as readonly string[]).includes(r.type)) add(taxable, r.type as SellerLedgerTypeValue, -r.amountPaise);
    if (r.type === 'CLOWE_FEE_GST') add(gstByGroup, r.chargeType ?? 'ORDER_FEES', -r.amountPaise);
    // Penalties are on the invoice through their GST lines (the taxable amount rides on them),
    // so penalties from before GST applied to them, and waived ones, add up right.
    if (r.type === 'CLOWE_FEE_GST' && r.chargeType && PENALTY_INVOICE_TYPES.includes(r.chargeType as never)) add(penaltyBase, r.chargeType, r.taxablePaise ?? 0);
  }
  // Returns in the month: the order fees on those lines come back (a credit).
  const reversedItems = rows.filter((r) => r.type === 'RETURN_REVERSAL' && r.orderItemId).map((r) => r.orderItemId!);
  if (reversedItems.length) {
    const original = await prisma.sellerLedgerEntry.findMany({
      where: { orderItemId: { in: reversedItems }, type: { in: [...ORDER_FEE_TYPES, 'CLOWE_FEE_GST'] } },
      select: { type: true, amountPaise: true },
    });
    for (const r of original) {
      if (r.type === 'CLOWE_FEE_GST') add(gstByGroup, 'ORDER_FEES', r.amountPaise);
      else add(taxable, r.type as SellerLedgerTypeValue, r.amountPaise);
    }
  }

  const supplierState = settings.legalEntity.gstin.slice(0, 2);
  const recipientState = seller.gstNumber?.slice(0, 2) ?? null;
  const intraState = !!recipientState && recipientState === supplierState;
  const rate = c.fees.gstPercent;
  const lines: SellerInvoiceLine[] = [];
  const push = (key: string, label: string, base: number, gst: number) => {
    if (base === 0 && gst === 0) return;
    const half = Math.floor(gst / 2);
    lines.push({
      key,
      label,
      sac: c.invoice.sacCode,
      taxablePaise: base,
      gstRatePercent: rate,
      cgstPaise: intraState ? half : 0,
      sgstPaise: intraState ? gst - half : 0,
      igstPaise: intraState ? 0 : gst,
      totalPaise: base + gst,
    });
  };
  const feeTypes = ORDER_FEE_TYPES.filter((t) => (taxable.get(t) ?? 0) !== 0);
  const feeGst = spread(gstByGroup.get('ORDER_FEES') ?? 0, feeTypes.map((t) => taxable.get(t) ?? 0));
  feeTypes.forEach((t, i) => push(t, LABELS[t] ?? SELLER_LEDGER_TYPE_LABELS[t], taxable.get(t) ?? 0, feeGst[i]!));
  for (const t of ['SUBSCRIPTION_FEE', 'AD_SPEND', 'SPONSORSHIP_FEE', 'TRYON_CREDITS'] as const) {
    push(t, SELLER_LEDGER_TYPE_LABELS[t], taxable.get(t) ?? 0, gstByGroup.get(t) ?? 0);
  }
  for (const t of PENALTY_INVOICE_TYPES) {
    push(t, SELLER_LEDGER_TYPE_LABELS[t], penaltyBase.get(t) ?? 0, gstByGroup.get(t) ?? 0);
  }
  const sum = (k: keyof SellerInvoiceLine) => lines.reduce((s, l) => s + (l[k] as number), 0);
  const address = (parts: (string | null)[]) => parts.filter(Boolean).join(', ');
  return {
    number: null,
    month,
    issuedAt: null,
    supplier: {
      name: settings.legalEntity.name,
      gstin: settings.legalEntity.gstin || null,
      address: settings.legalEntity.registeredAddress,
      state: 'Delhi',
    },
    recipient: {
      name: seller.panName ?? seller.shopName,
      gstin: seller.gstNumber,
      address: address([seller.addressLine1, seller.city, seller.state, seller.pincode]),
      state: seller.state,
    },
    intraState,
    lines,
    totals: { taxablePaise: sum('taxablePaise'), cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'), igstPaise: sum('igstPaise'), totalPaise: sum('totalPaise') },
    notes: [
      'Charges are deducted from your payouts or paid from your Seller Wallet as shown on your statement.',
      'Advertising paid with advertising credit is not charged and is not listed.',
      'Fees on orders placed before the current fee schedule carried no GST and are listed at 0% where they appear.',
    ],
  };
}

/** The financial year (April–March) a month falls in, e.g. "2026-27". */
function financialYear(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const start = m! >= 4 ? y! : y! - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Tells the seller (in the app, and by email through the notification bridge) that the invoice is ready. */
async function notifyInvoiceReady(sellerId: string, month: string, number: string, totalPaise: number): Promise<void> {
  const seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { userId: true } });
  if (!seller) return;
  const [y, m] = month.split('-').map(Number);
  const label = new Date(Date.UTC(y!, m! - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  await prisma.notification.create({
    data: {
      userId: seller.userId,
      type: 'SELLER_INVOICE',
      title: `Your ${label} invoice is ready`,
      body: `Clowe's tax invoice ${number} for ${label} is ready: ₹${(totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in fees and charges, including GST. You can view and download it in Billing.`,
      linkHref: `/seller/billing/invoices/${month}`,
    },
  });
}

/** Issue a month's invoice (once): fix its number and figures. Null when there is nothing to invoice. */
export async function issueMonthlyInvoice(sellerId: string, month: string): Promise<SellerMonthlyInvoice | null> {
  const existing = await prisma.sellerTaxInvoice.findUnique({ where: { sellerId_month: { sellerId, month } } });
  if (existing) return existing.document as unknown as SellerMonthlyInvoice;
  if (month >= istMonthOf(new Date())) throw ApiError.badRequest('A month is invoiced once it has ended', 'MONTH_NOT_OVER');
  const doc = await buildMonthlyInvoice(sellerId, month);
  if (doc.lines.length === 0) return null;
  const { invoice } = await getCommercial();
  const fy = financialYear(month);
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = (await prisma.sellerTaxInvoice.count({ where: { number: { startsWith: `${invoice.numberPrefix}/${fy}/` } } })) + 1 + attempt;
    const number = `${invoice.numberPrefix}/${fy}/${String(seq).padStart(6, '0')}`;
    const issuedAt = new Date();
    const document = { ...doc, number, issuedAt: issuedAt.toISOString() };
    try {
      await prisma.sellerTaxInvoice.create({ data: { sellerId, month, number, issuedAt, document: document as unknown as object } });
      await notifyInvoiceReady(sellerId, month, number, doc.totals.totalPaise);
      return document;
    } catch (err) {
      const again = await prisma.sellerTaxInvoice.findUnique({ where: { sellerId_month: { sellerId, month } } });
      if (again) return again.document as unknown as SellerMonthlyInvoice;
      if (attempt === 4) throw err;
    }
  }
  return null;
}

/** Issue last month's invoices for every seller with charges. */
export async function issueLastMonthInvoices(now: Date = new Date()): Promise<number> {
  const thisMonth = istMonthOf(now);
  const [y, m] = thisMonth.split('-').map(Number);
  const last = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
  const { from, to } = istMonthBounds(last);
  const sellers = await prisma.sellerLedgerEntry.findMany({
    where: { createdAt: { gte: from, lt: to }, type: { in: [...CLOWE_CHARGE_TYPES, 'CLOWE_FEE_GST', 'RETURN_REVERSAL'] } },
    distinct: ['sellerId'],
    select: { sellerId: true },
  });
  let issued = 0;
  for (const s of sellers) if (await issueMonthlyInvoice(s.sellerId, last).catch(() => null)) issued += 1;
  return issued;
}

export function startSellerInvoiceJob(): void {
  const run = () => {
    issueLastMonthInvoices()
      .then((n) => {
        if (n > 0) console.log(`[clowe-api] seller tax invoices issued: ${n}`);
      })
      .catch((err) => console.error('[clowe-api] seller invoice job failed:', err));
  };
  run();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref();
}

/** The seller's invoices: issued months, and this month so far as a draft. */
export async function invoiceList(sellerId: string): Promise<SellerInvoiceListRow[]> {
  const issued = await prisma.sellerTaxInvoice.findMany({ where: { sellerId }, orderBy: { month: 'desc' } });
  const current = istMonthOf(new Date());
  const draft = await buildMonthlyInvoice(sellerId, current);
  return [
    ...(draft.lines.length ? [{ month: current, number: null, totalPaise: draft.totals.totalPaise, draft: true }] : []),
    ...issued.map((i) => ({ month: i.month, number: i.number, totalPaise: (i.document as unknown as SellerMonthlyInvoice).totals.totalPaise, draft: false })),
  ];
}

/** One month: the issued invoice, or this month's draft, or (for a past month not yet issued) issued now. */
export async function invoiceFor(sellerId: string, month: string): Promise<SellerMonthlyInvoice> {
  if (month >= istMonthOf(new Date())) return buildMonthlyInvoice(sellerId, month);
  const doc = await issueMonthlyInvoice(sellerId, month);
  if (!doc) throw ApiError.notFound('No Clowe charges in that month');
  return doc;
}
