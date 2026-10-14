import { parseCsv, type CodRemittanceImportResult, type CodRemittanceRowResult } from '@clowe/shared';
import { prisma } from '../../db';
import { ApiError } from '../../utils/ApiError';

// ---------------------------------------------------------------------------
// COD money, matched to Delhivery's remittances.
//
// Delhivery collects COD cash at the door and pays it to Clowe's bank later,
// in batches, with a report (Delhivery One → Finances → Remittance: AWB, COD
// amount, the bank transaction reference). A COD line becomes payable to its
// seller only once the remittance for its parcel's AWB is matched here —
// besides the usual return-window hold.
//
// An admin uploads the report as CSV. Each row is matched by AWB and amount:
// MATCHED marks the parcel remitted; a different amount is a MISMATCH, an AWB
// we don't know is UNKNOWN, an AWB already matched is a DUPLICATE — none of
// those releases anything. An admin can also mark one parcel remitted by hand,
// with the reference, for money that arrived outside a report.
// ---------------------------------------------------------------------------

/** Which column holds what, from the report's header (its exact names are not documented). */
function columns(header: string[]) {
  const find = (...patterns: RegExp[]) => header.findIndex((h) => patterns.some((p) => p.test(h)));
  return {
    awb: find(/^awb/i, /waybill/i, /\bawb\b/i),
    amount: find(/cod.*amount/i, /amount.*cod/i, /^amount/i, /collect/i),
    reference: find(/utr/i, /transaction/i, /reference/i, /\bref\b/i),
    date: find(/remit.*date/i, /date/i),
  };
}

/** "₹1,234.50" / "1234.5" → paise; NaN when it isn't a number. */
function rupeesToPaise(text: string): number {
  const n = Number(text.replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
}

export async function importRemittances(csv: string, adminId: string, fileName: string | null): Promise<CodRemittanceImportResult> {
  const rows = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) throw ApiError.badRequest('The file has no rows under its header', 'EMPTY_REPORT');
  const col = columns(rows[0]!.map((h) => h.trim()));
  if (col.awb < 0 || col.amount < 0) {
    throw ApiError.badRequest('Could not find the AWB and COD amount columns in the header', 'UNKNOWN_FORMAT');
  }

  const batch = await prisma.codRemittanceImport.create({ data: { uploadedById: adminId, fileName, rowCount: rows.length - 1 } });
  const results: CodRemittanceRowResult[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const awbNumber = (row[col.awb] ?? '').trim();
    const amountPaise = rupeesToPaise(row[col.amount] ?? '');
    const reference = col.reference >= 0 ? (row[col.reference] ?? '').trim() || null : null;
    const remittedOn = col.date >= 0 ? (row[col.date] ?? '').trim() || null : null;
    if (!awbNumber) continue;

    const shipment = await prisma.shipment.findUnique({
      where: { awbNumber },
      select: { id: true, paymentType: true, codAmountPaise: true, codRemittedAt: true, order: { select: { orderNumber: true } } },
    });
    let status: CodRemittanceRowResult['status'];
    let note: string | null = null;
    if (!shipment || shipment.paymentType !== 'COD') {
      status = 'UNKNOWN';
      note = shipment ? 'Not a COD parcel' : 'No parcel of ours has this AWB';
    } else if (shipment.codRemittedAt || seen.has(awbNumber)) {
      status = 'DUPLICATE';
      note = 'Already matched';
    } else if (Number.isNaN(amountPaise) || amountPaise !== shipment.codAmountPaise) {
      status = 'MISMATCH';
      note = `Expected ₹${(shipment.codAmountPaise / 100).toFixed(2)}`;
    } else {
      status = 'MATCHED';
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { codRemittedAt: new Date(), codRemittanceRef: reference ?? `import:${batch.id}` },
      });
    }
    seen.add(awbNumber);
    await prisma.codRemittanceRow.create({
      data: {
        importId: batch.id,
        awbNumber,
        amountPaise: Number.isNaN(amountPaise) ? 0 : amountPaise,
        reference,
        remittedOn,
        shipmentId: shipment?.id ?? null,
        status,
        note,
      },
    });
    results.push({ awbNumber, amountPaise: Number.isNaN(amountPaise) ? null : amountPaise, reference, status, note, orderNumber: shipment?.order.orderNumber ?? null });
  }
  const count = (s: CodRemittanceRowResult['status']) => results.filter((r) => r.status === s).length;
  const summary = { matched: count('MATCHED'), mismatched: count('MISMATCH'), unknown: count('UNKNOWN'), duplicate: count('DUPLICATE') };
  await prisma.codRemittanceImport.update({ where: { id: batch.id }, data: summary });
  return { importId: batch.id, rows: results, ...summary };
}

/** Money that arrived outside a report: mark one COD parcel remitted, with its reference. */
export async function markRemitted(shipmentId: string, reference: string): Promise<void> {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { paymentType: true, status: true, codRemittedAt: true } });
  if (!shipment) throw ApiError.notFound('Parcel not found');
  if (shipment.paymentType !== 'COD') throw ApiError.badRequest('Not a COD parcel', 'NOT_COD');
  if (shipment.status !== 'DELIVERED') throw ApiError.badRequest('Only a delivered COD parcel is remitted', 'NOT_DELIVERED');
  if (shipment.codRemittedAt) throw ApiError.badRequest('Already marked remitted', 'ALREADY_REMITTED');
  await prisma.shipment.update({ where: { id: shipmentId }, data: { codRemittedAt: new Date(), codRemittanceRef: reference } });
}

/** Delivered COD parcels whose cash Delhivery hasn't remitted yet, oldest first. */
export async function awaitingRemittance(take = 200) {
  const parcels = await prisma.shipment.findMany({
    where: { paymentType: 'COD', status: 'DELIVERED', codRemittedAt: null },
    orderBy: { deliveredAt: 'asc' },
    take,
    select: {
      id: true,
      awbNumber: true,
      codAmountPaise: true,
      deliveredAt: true,
      order: { select: { orderNumber: true } },
      seller: { select: { shopName: true } },
    },
  });
  return parcels.map((p) => ({
    shipmentId: p.id,
    awbNumber: p.awbNumber,
    orderNumber: p.order.orderNumber,
    shopName: p.seller.shopName,
    codAmountPaise: p.codAmountPaise,
    deliveredAt: p.deliveredAt?.toISOString() ?? null,
  }));
}
