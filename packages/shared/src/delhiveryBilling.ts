import { z } from 'zod';

// ---------------------------------------------------------------------------
// Delhivery billing check: Delhivery's monthly billing (MIS) export, matched by
// AWB to our parcels, against what the seller ledger charged each seller for
// the same trip — forward, RTO, and customer-return pickup (DTO). Nothing is
// posted by the check itself: an admin confirms each adjustment, one line at
// a time.
//
// Delhivery's export format is not documented to us, so which column holds
// what is the admin's to set. Until they do, the header is read with the
// guesses below.
// ---------------------------------------------------------------------------

export const DELHIVERY_BILLING_FIELDS = ['awb', 'weight', 'forward', 'rto', 'dto', 'total', 'gst'] as const;
export type DelhiveryBillingField = (typeof DELHIVERY_BILLING_FIELDS)[number];

export const DELHIVERY_BILLING_FIELD_LABELS: Record<DelhiveryBillingField, string> = {
  awb: 'AWB / waybill',
  weight: 'Charged weight',
  forward: 'Forward freight',
  rto: 'RTO charge',
  dto: 'Return pickup (DTO) charge',
  total: 'Total (used only when no charge column is found)',
  gst: 'GST',
};

/**
 * Header guesses per field, most likely first. Compared without case, spaces
 * or punctuation, so "AWB No." matches "awb no". Unverified against a real
 * Delhivery export.
 */
export const DELHIVERY_BILLING_ALIASES: Record<DelhiveryBillingField, readonly string[]> = {
  awb: ['Waybill', 'AWB', 'AWB Number', 'AWB No', 'Waybill No', 'Waybill Number', 'AWB Code', 'Air Waybill'],
  weight: ['Charged Weight', 'Chargeable Weight', 'Billed Weight', 'Charged Wt', 'Billing Weight', 'Weight'],
  forward: [
    'Forward Charge', 'Forward Charges', 'Forward Freight', 'Forward Amount', 'FWD Charge', 'FWD Charges',
    'Freight', 'Freight Charge', 'Freight Charges', 'Shipping Charge', 'Shipping Charges',
  ],
  rto: ['RTO Charge', 'RTO Charges', 'RTO Amount', 'RTO Freight', 'Return to Origin Charge', 'Return to Origin Charges'],
  dto: [
    'DTO Charge', 'DTO Charges', 'DTO Amount', 'Reverse Charge', 'Reverse Charges', 'Reverse Pickup Charge',
    'Reverse Pickup Charges', 'Return Charge', 'Return Charges', 'RVP Charge', 'RVP Charges',
  ],
  total: ['Total', 'Total Amount', 'Total Charge', 'Total Charges', 'Grand Total', 'Gross Amount', 'Net Amount'],
  gst: ['GST', 'GST Amount', 'Total GST', 'Tax', 'Tax Amount', 'Total Tax'],
};

/** Which column holds what. A null header means "guess from the aliases". */
export interface DelhiveryBillingColumns {
  awb: string | null;
  weight: string | null;
  forward: string | null;
  rto: string | null;
  dto: string | null;
  total: string | null;
  gst: string | null;
  /** The weight column's unit. */
  weightUnit: 'KG' | 'GRAMS';
  /**
   * Whether the amounts already include GST. Our ledger's do. When they don't,
   * the GST column is added, or 18 % when there is none.
   */
  amountsIncludeGst: boolean;
}

export const DEFAULT_DELHIVERY_BILLING_COLUMNS: DelhiveryBillingColumns = {
  awb: null,
  weight: null,
  forward: null,
  rto: null,
  dto: null,
  total: null,
  gst: null,
  weightUnit: 'KG',
  amountsIncludeGst: false,
};

const header = z.string().trim().max(120).nullable().transform((h) => (h ? h : null));

/** PUT /api/admin/delhivery-billing/columns */
export const delhiveryBillingColumnsSchema = z.object({
  awb: header,
  weight: header,
  forward: header,
  rto: header,
  dto: header,
  total: header,
  gst: header,
  weightUnit: z.enum(['KG', 'GRAMS']),
  amountsIncludeGst: z.boolean(),
});

/** POST /api/admin/delhivery-billing/checks — the month's export as CSV text. */
export const delhiveryBillingUploadSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Give the month as YYYY-MM'),
  fileName: z.string().trim().min(1).max(200),
  // The API takes JSON bodies up to 1 MB; a bigger month goes up in parts.
  csv: z.string().min(1, 'Choose the billing file').max(1_000_000, 'The file is over 1 MB — split it and upload each part'),
});

/** POST /api/admin/delhivery-billing/lines/:id/adjust — posted only when the admin confirms. */
export const delhiveryBillingAdjustSchema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm the adjustment' }) }),
});

/** Header text compared as Delhivery might vary it: no case, spaces or punctuation. */
export function normalizeBillingHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The column index of each field in `headers` (−1 when absent): the admin's
 * chosen header when the file has it, else the first alias that matches.
 */
export function resolveBillingColumns(
  headers: string[],
  columns: DelhiveryBillingColumns,
): Record<DelhiveryBillingField, number> {
  const normalized = headers.map(normalizeBillingHeader);
  const indexOf = (name: string) => normalized.indexOf(normalizeBillingHeader(name));
  const out = {} as Record<DelhiveryBillingField, number>;
  for (const field of DELHIVERY_BILLING_FIELDS) {
    const chosen = columns[field];
    let at = chosen ? indexOf(chosen) : -1;
    for (const alias of DELHIVERY_BILLING_ALIASES[field]) {
      if (at >= 0) break;
      at = indexOf(alias);
    }
    out[field] = at;
  }
  return out;
}

export const DELHIVERY_BILLING_KINDS = ['FORWARD', 'RTO', 'DTO'] as const;
export type DelhiveryBillingKind = (typeof DELHIVERY_BILLING_KINDS)[number];

export const DELHIVERY_BILLING_STATUSES = ['MATCHED', 'MISMATCH', 'NOT_ON_LEDGER', 'UNKNOWN_AWB'] as const;
export type DelhiveryBillingStatus = (typeof DELHIVERY_BILLING_STATUSES)[number];
export const DELHIVERY_BILLING_STATUS_LABELS: Record<DelhiveryBillingStatus, string> = {
  MATCHED: 'Matches the ledger',
  MISMATCH: 'Differs from the ledger',
  NOT_ON_LEDGER: 'Not charged to the seller yet',
  UNKNOWN_AWB: 'Not one of our parcels',
};

export interface DelhiveryBillingLineRow {
  id: string;
  awbNumber: string;
  kind: DelhiveryBillingKind;
  shipmentId: string | null;
  sellerId: string | null;
  shopName: string | null;
  orderId: string | null;
  orderNumber: string | null;
  billedPaise: number;
  billedWeightGrams: number | null;
  /** Null when nothing is posted for this trip yet. */
  ledgerPaise: number | null;
  ledgerWeightGrams: number | null;
  /** billed − ledger: + the seller owes more, − they are owed back. */
  differencePaise: number;
  status: DelhiveryBillingStatus;
  adjustmentEntryId: string | null;
  adjustedAt: string | null;
}

/** One seller's lines in a check (sellerId null: AWBs that aren't ours). */
export interface DelhiveryBillingSellerTotal {
  sellerId: string | null;
  shopName: string | null;
  lines: number;
  mismatched: number;
  billedPaise: number;
  ledgerPaise: number;
  differencePaise: number;
  /** The difference on lines not adjusted yet. */
  openDifferencePaise: number;
}

export interface DelhiveryBillingSummary {
  counts: Record<DelhiveryBillingStatus, number>;
  billedPaise: number;
  ledgerPaise: number;
  differencePaise: number;
  sellers: DelhiveryBillingSellerTotal[];
}

export interface DelhiveryBillingCheckListItem {
  id: string;
  month: string;
  fileName: string;
  rowCount: number;
  createdAt: string;
  counts: Record<DelhiveryBillingStatus, number>;
  differencePaise: number;
}

export interface DelhiveryBillingCheckView {
  id: string;
  month: string;
  fileName: string;
  rowCount: number;
  createdAt: string;
  /** The file's header, and the column each field was read from (null: not found). */
  headers: string[];
  columnsUsed: Record<DelhiveryBillingField, string | null>;
  columns: DelhiveryBillingColumns;
  summary: DelhiveryBillingSummary;
  lines: DelhiveryBillingLineRow[];
}

/** The upload's answer: the check, and the rows that could not be read. */
export interface DelhiveryBillingUploadResult extends DelhiveryBillingCheckView {
  skipped: { row: number; reason: string }[];
}

/** GET /api/admin/delhivery-billing/columns */
export interface DelhiveryBillingColumnsView {
  columns: DelhiveryBillingColumns;
  /** The header of the last file uploaded, to pick from. */
  lastHeaders: string[];
  lastFileName: string | null;
}
