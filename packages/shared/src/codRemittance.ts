import { z } from 'zod';

// ---------------------------------------------------------------------------
// COD remittance: Delhivery's report of the COD cash it paid Clowe, matched to
// our parcels by AWB and amount. A COD line is payable to its seller only once
// its parcel's remittance is matched.
// ---------------------------------------------------------------------------

/**
 * CSV to rows of cells: commas, double-quoted cells (with "" for a quote),
 * and CRLF or LF line ends. Enough for a bank or courier export.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export const COD_REMITTANCE_STATUSES = ['MATCHED', 'MISMATCH', 'UNKNOWN', 'DUPLICATE'] as const;
export type CodRemittanceStatus = (typeof COD_REMITTANCE_STATUSES)[number];
export const COD_REMITTANCE_STATUS_LABELS: Record<CodRemittanceStatus, string> = {
  MATCHED: 'Matched — payable to the seller',
  MISMATCH: 'Amount differs — not released',
  UNKNOWN: 'Not one of our COD parcels',
  DUPLICATE: 'Already matched',
};

export interface CodRemittanceRowResult {
  awbNumber: string;
  amountPaise: number | null;
  reference: string | null;
  status: CodRemittanceStatus;
  note: string | null;
  orderNumber: string | null;
}

export interface CodRemittanceImportResult {
  importId: string;
  rows: CodRemittanceRowResult[];
  matched: number;
  mismatched: number;
  unknown: number;
  duplicate: number;
}

/** A delivered COD parcel whose cash Delhivery hasn't remitted yet. */
export interface CodAwaitingRemittance {
  shipmentId: string;
  awbNumber: string | null;
  orderNumber: string;
  shopName: string;
  codAmountPaise: number;
  deliveredAt: string | null;
}

export interface CodRemittanceOverview {
  awaiting: CodAwaitingRemittance[];
  awaitingTotalPaise: number;
  imports: { id: string; fileName: string | null; rowCount: number; matched: number; mismatched: number; unknown: number; duplicate: number; createdAt: string }[];
}

/** POST /api/admin/cod-remittances/import — the report as CSV text. */
export const codRemittanceImportSchema = z.object({
  csv: z.string().min(1, 'Choose the remittance report').max(5_000_000),
  fileName: z.string().trim().max(200).optional(),
});

/** POST /api/admin/cod-remittances/parcels/:id/mark — remitted outside a report. */
export const codRemittanceMarkSchema = z.object({
  reference: z.string().trim().min(3, 'Give the bank transaction reference').max(100),
});
