// ---------------------------------------------------------------------------
// Clowe's monthly tax invoice to a seller (owner's Batch 2): every charge
// Clowe made in the month — order fees, plan, advertising, sponsorship, AI
// Try-On credits — with GST, issued by CLOWE PARTNERS LLP. Downloadable from
// the seller dashboard.
// ---------------------------------------------------------------------------

export interface SellerInvoiceParty {
  name: string;
  gstin: string | null;
  address: string;
  state: string | null;
}

export interface SellerInvoiceLine {
  key: string;
  label: string;
  sac: string;
  taxablePaise: number;
  gstRatePercent: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

export interface SellerMonthlyInvoice {
  /** null while the month is still running (a draft, not a tax invoice yet). */
  number: string | null;
  month: string;
  issuedAt: string | null;
  supplier: SellerInvoiceParty;
  recipient: SellerInvoiceParty;
  intraState: boolean;
  /** The recipient's state for GST, "07 Delhi"; null when it can't be told. */
  placeOfSupply?: string | null;
  lines: SellerInvoiceLine[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number };
  notes: string[];
}

export interface SellerInvoiceListRow {
  month: string;
  number: string | null;
  totalPaise: number;
  draft: boolean;
}

/** Most characters a GST invoice number may have (CGST Rules, rule 46(b)). */
export const INVOICE_NUMBER_MAX = 16;

/** The financial year (April–March) a YYYY-MM month falls in, e.g. "2026-27". */
export function financialYearOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const start = m! >= 4 ? y! : y! - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Clowe's invoice number to a seller: prefix, financial year and a running
 * number, "CLW/2627/000001" — consecutive within each financial year and never
 * longer than 16 characters.
 */
export function sellerInvoiceNumber(prefix: string, financialYear: string, seq: number): string {
  const fy = `${financialYear.slice(2, 4)}${financialYear.slice(5, 7)}`;
  const number = `${prefix}/${fy}/${String(seq).padStart(6, '0')}`;
  if (number.length > INVOICE_NUMBER_MAX) throw new Error(`Invoice number ${number} is longer than ${INVOICE_NUMBER_MAX} characters`);
  return number;
}

/** "2026-10" → "October 2026". */
export function invoiceMonthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The India-time month a moment falls in, YYYY-MM. */
export function istMonthOf(at: Date): string {
  const ist = new Date(at.getTime() + 5.5 * 3_600_000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The instants an India-time month starts and ends. */
export function istMonthBounds(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y!, m! - 1, 1) - 5.5 * 3_600_000);
  const to = new Date(Date.UTC(y!, m!, 1) - 5.5 * 3_600_000);
  return { from, to };
}
