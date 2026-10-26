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

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0–999 in words: "Five Hundred Thirty-Three". */
function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const tens = rest < 20 ? ONES[rest]! : `${TENS[Math.floor(rest / 10)]!}${rest % 10 ? `-${ONES[rest % 10]!}` : ''}`;
  return [hundreds ? `${ONES[hundreds]!} Hundred` : '', tens].filter(Boolean).join(' ');
}

/** A whole number in words, the Indian way: crore, lakh, thousand. */
function inWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1_000);
  const rest = n % 1_000;
  if (crore) parts.push(`${inWords(crore)} Crore`);
  if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));
  return parts.join(' ');
}

/** An invoice total in words: "Rupees Nine Thousand Five Hundred Thirty-Three and Twenty-Two Paise Only". */
export function rupeesInWords(paise: number): string {
  const whole = Math.floor(Math.abs(paise) / 100);
  const fraction = Math.abs(paise) % 100;
  return `${paise < 0 ? 'Minus ' : ''}Rupees ${inWords(whole)}${fraction ? ` and ${inWords(fraction)} Paise` : ''} Only`;
}
