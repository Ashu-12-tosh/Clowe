/**
 * Bank names by IFSC prefix. The first four letters of an IFSC identify the
 * bank, so a seller who has typed their IFSC has already told us this; the
 * form fills it in and lets them correct it. The field itself stays required
 * and editable, and the server never derives it — a prefix we do not know is
 * simply one the seller types for themselves.
 */
export const IFSC_BANK_NAMES: Record<string, string> = {
  SBIN: 'State Bank of India',
  HDFC: 'HDFC Bank',
  ICIC: 'ICICI Bank',
  UTIB: 'Axis Bank',
  KKBK: 'Kotak Mahindra Bank',
  PUNB: 'Punjab National Bank',
  BARB: 'Bank of Baroda',
  CNRB: 'Canara Bank',
  IDIB: 'Indian Bank',
  UBIN: 'Union Bank of India',
  IOBA: 'Indian Overseas Bank',
  BKID: 'Bank of India',
  CBIN: 'Central Bank of India',
  MAHB: 'Bank of Maharashtra',
  UCBA: 'UCO Bank',
  PSIB: 'Punjab & Sind Bank',
  INDB: 'IndusInd Bank',
  YESB: 'Yes Bank',
  FDRL: 'Federal Bank',
  KARB: 'Karnataka Bank',
  SIBL: 'South Indian Bank',
  CIUB: 'City Union Bank',
  RATN: 'RBL Bank',
  AUBL: 'AU Small Finance Bank',
  IDFB: 'IDFC First Bank',
  ESFB: 'Equitas Small Finance Bank',
  UJVN: 'Ujjivan Small Finance Bank',
  BDBL: 'Bandhan Bank',
  DLXB: 'Dhanlaxmi Bank',
  KVBL: 'Karur Vysya Bank',
  TMBL: 'Tamilnad Mercantile Bank',
  JAKA: 'Jammu & Kashmir Bank',
  PYTM: 'Paytm Payments Bank',
  AIRP: 'Airtel Payments Bank',
  FINO: 'Fino Payments Bank',
  DBSS: 'DBS Bank',
  HSBC: 'HSBC',
  SCBL: 'Standard Chartered Bank',
  CITI: 'Citibank',
  DEUT: 'Deutsche Bank',
};

/** The bank an IFSC belongs to, or null for one not in the table or not an IFSC at all. */
export function bankNameFromIfsc(ifsc: string): string | null {
  const code = ifsc.trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return null;
  return IFSC_BANK_NAMES[code.slice(0, 4)] ?? null;
}
