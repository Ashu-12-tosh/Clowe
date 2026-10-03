import { computeListingEconomics, istDayStart } from '@clowe/shared';
import { prisma } from '../db';
import { categoryRulesMap } from './categoryRules';
import { economicsRates } from './economicsRates';
import { getSettings } from './settingsService';

// ---------------------------------------------------------------------------
// GSTR-8: the monthly return of GST TCS the marketplace collected (s.52).
//
// Built from the seller ledger, so it is the TCS actually taken, not a
// recalculation: a supply is a GST_TCS entry posted in the month (on
// delivery); a supply returned is a return reversal posted in the month,
// counted at the TCS and taxable value its delivery recorded. Months are
// Indian calendar months.
//
// Place of supply decides the split: the buyer's delivery state against the
// seller's registered state. Same state, CGST and SGST in halves; otherwise
// IGST. A seller with no state on file is treated as inter-state and flagged.
// ---------------------------------------------------------------------------

export interface Gstr8Row {
  sellerId: string;
  gstin: string | null;
  tradeName: string;
  suppliesTaxablePaise: number;
  returnsTaxablePaise: number;
  netTaxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  lines: number;
  notes: string[];
}

const normaliseState = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The month "YYYY-MM" as Indian-calendar instants. */
export function gstr8Period(month: string): { from: Date; to: Date } {
  const [year, m] = month.split('-').map(Number);
  return { from: istDayStart(year, m - 1), to: istDayStart(year, m) };
}

export async function gstr8Rows(month: string): Promise<Gstr8Row[]> {
  const { from, to } = gstr8Period(month);
  const select = {
    amountPaise: true,
    taxablePaise: true,
    sellerId: true,
    orderItemId: true,
    orderItem: {
      select: {
        pricePaise: true,
        gstRatePercent: true,
        quantity: true,
        product: { select: { categoryId: true } },
        order: { select: { shipState: true } },
      },
    },
  } as const;

  const supplies = await prisma.sellerLedgerEntry.findMany({
    where: { type: 'GST_TCS', bucket: 'SETTLEMENT', createdAt: { gte: from, lt: to } },
    select,
  });
  const reversals = await prisma.sellerLedgerEntry.findMany({
    where: { type: 'RETURN_REVERSAL', bucket: 'SETTLEMENT', createdAt: { gte: from, lt: to }, orderItemId: { not: null } },
    select: { orderItemId: true },
  });
  // Returns are counted at what their delivery recorded, whichever month that was.
  const returned = reversals.length
    ? await prisma.sellerLedgerEntry.findMany({
        where: { type: 'GST_TCS', bucket: 'SETTLEMENT', orderItemId: { in: reversals.map((r) => r.orderItemId!) } },
        select,
      })
    : [];

  // Entries posted before taxable values were recorded: recalculate them.
  const settings = await getSettings();
  const rates = economicsRates(settings);
  const rules = await categoryRulesMap(
    [...supplies, ...returned].flatMap((e) => (e.orderItem ? [e.orderItem.product.categoryId] : [])),
  );
  const taxableOf = (e: (typeof supplies)[number]) => {
    if (e.taxablePaise !== null) return e.taxablePaise;
    if (!e.orderItem) return 0;
    return computeListingEconomics({
      buyerPricePaise: e.orderItem.pricePaise,
      gstRatePercent: e.orderItem.gstRatePercent,
      quantity: e.orderItem.quantity,
      rates,
      taxRules: rules.get(e.orderItem.product.categoryId),
    }).exGstPaise;
  };

  const sellerIds = [...new Set([...supplies, ...returned].map((e) => e.sellerId))];
  const sellers = await prisma.sellerProfile.findMany({
    where: { id: { in: sellerIds } },
    select: { id: true, shopName: true, gstNumber: true, state: true },
  });
  const byId = new Map(sellers.map((s) => [s.id, s]));
  const rows = new Map<string, Gstr8Row>();
  const rowFor = (sellerId: string): Gstr8Row => {
    let row = rows.get(sellerId);
    if (!row) {
      const s = byId.get(sellerId);
      row = {
        sellerId,
        gstin: s?.gstNumber ?? null,
        tradeName: s?.shopName ?? '(unknown seller)',
        suppliesTaxablePaise: 0,
        returnsTaxablePaise: 0,
        netTaxablePaise: 0,
        igstPaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        lines: 0,
        notes: [],
      };
      if (!row.gstin) row.notes.push('No GSTIN on file');
      if (!s?.state) row.notes.push('No seller state on file: treated as inter-state');
      rows.set(sellerId, row);
    }
    return row;
  };

  const add = (e: (typeof supplies)[number], sign: 1 | -1) => {
    const row = rowFor(e.sellerId);
    const tcs = -e.amountPaise * sign; // ledger deductions are negative
    const taxable = taxableOf(e) * sign;
    if (sign === 1) row.suppliesTaxablePaise += taxable;
    else row.returnsTaxablePaise -= taxable;
    const seller = byId.get(e.sellerId);
    const intra = !!seller?.state && normaliseState(seller.state) === normaliseState(e.orderItem?.order.shipState);
    if (intra) {
      const cgst = Math.trunc(tcs / 2);
      row.cgstPaise += cgst;
      row.sgstPaise += tcs - cgst;
    } else {
      row.igstPaise += tcs;
    }
    row.lines += 1;
  };
  for (const e of supplies) add(e, 1);
  for (const e of returned) add(e, -1);

  return [...rows.values()]
    .map((r) => ({ ...r, netTaxablePaise: r.suppliesTaxablePaise - r.returnsTaxablePaise }))
    .sort((a, b) => (a.gstin ?? '~').localeCompare(b.gstin ?? '~'));
}
