// ---------------------------------------------------------------------------
// Where Clowe's charges to a seller are supplied, for the GST on them: CGST +
// SGST when the seller is in Clowe's own state, IGST otherwise. A registered
// seller's state is the one in their GSTIN; an unregistered seller's is the
// state of their address (place of supply, IGST Act s.12(2)). Clowe's own is
// the state in its GSTIN.
// ---------------------------------------------------------------------------

/** GST state codes by state or union territory name. */
const STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01',
  'himachal pradesh': '02',
  punjab: '03',
  chandigarh: '04',
  uttarakhand: '05',
  uttaranchal: '05',
  haryana: '06',
  delhi: '07',
  'new delhi': '07',
  'nct of delhi': '07',
  rajasthan: '08',
  'uttar pradesh': '09',
  bihar: '10',
  sikkim: '11',
  'arunachal pradesh': '12',
  nagaland: '13',
  manipur: '14',
  mizoram: '15',
  tripura: '16',
  meghalaya: '17',
  assam: '18',
  'west bengal': '19',
  jharkhand: '20',
  odisha: '21',
  orissa: '21',
  chhattisgarh: '22',
  'madhya pradesh': '23',
  gujarat: '24',
  'dadra and nagar haveli and daman and diu': '26',
  'daman and diu': '26',
  'dadra and nagar haveli': '26',
  maharashtra: '27',
  karnataka: '29',
  goa: '30',
  lakshadweep: '31',
  kerala: '32',
  'tamil nadu': '33',
  puducherry: '34',
  pondicherry: '34',
  'andaman and nicobar islands': '35',
  'andaman and nicobar': '35',
  telangana: '36',
  'andhra pradesh': '37',
  ladakh: '38',
};

/** The GST state code of a state's name ("Delhi", "NCT of Delhi", "Tamil Nadu"), or null. */
export function gstStateCodeOf(state: string | null | undefined): string | null {
  const key = (state ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return STATE_CODES[key] ?? null;
}

/** The seller's state for GST: from their GSTIN, else their address; null when neither says. */
export function recipientStateCode(seller: { gstNumber?: string | null; state?: string | null }): string | null {
  const fromGstin = seller.gstNumber?.trim().slice(0, 2);
  if (fromGstin && /^\d{2}$/.test(fromGstin)) return fromGstin;
  return gstStateCodeOf(seller.state);
}

/**
 * Whether a charge to this seller is intra-state (CGST + SGST). An unknown
 * state is treated as inter-state (IGST), the conservative reading.
 */
export function isIntraStateSupply(supplierGstin: string | null | undefined, seller: { gstNumber?: string | null; state?: string | null }): boolean {
  const supplier = supplierGstin?.trim().slice(0, 2);
  const recipient = recipientStateCode(seller);
  return !!supplier && !!recipient && supplier === recipient;
}

export interface GstSplit {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

/** A GST amount as CGST + SGST (halves, the odd paisa on SGST) or as IGST. */
export function splitGst(gstPaise: number, intraState: boolean): GstSplit {
  if (!intraState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: gstPaise };
  const half = Math.floor(gstPaise / 2);
  return { cgstPaise: half, sgstPaise: gstPaise - half, igstPaise: 0 };
}

const STATE_NAMES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

/** "07" → "Delhi"; null for a code that isn't a state's. */
export function gstStateName(code: string | null | undefined): string | null {
  return (code && STATE_NAMES[code]) || null;
}
