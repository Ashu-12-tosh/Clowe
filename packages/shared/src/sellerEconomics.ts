import type { SellerLedgerTypeValue } from './sellerLedger';

// ---------------------------------------------------------------------------
// Seller economics — THE formula.
//
// One place decides how a sale splits between the buyer, the marketplace and
// the seller. The ledger posts delivery entries straight from `lines`, the
// payout page explains deductions from the same numbers, and the product form
// previews them as the seller types a price. If any of those disagreed with
// each other the seller would be right to distrust all three, so none of them
// is allowed its own arithmetic.
//
// Money is in paise throughout and every component is rounded to a whole
// paisa on its own, so the parts always add up to the whole exactly.
// ---------------------------------------------------------------------------

/** The rates in force. Every one of these is an admin-editable platform setting. */
export interface SellerEconomicsRates {
  /** Marketplace commission, percent of the line total. */
  commissionPercent: number;
  /** Payment gateway / collection charge, percent of the line total. */
  gatewayPercent: number;
  /** Section 194-O TDS withheld, percent of the line total. */
  tdsPercent: number;
}

export interface SellerEconomicsInput {
  /** The price the seller lists, per unit — what the buyer is charged for it. */
  sellerPricePaise: number;
  /** Units on the line; defaults to one for the listing preview. */
  quantity?: number;
  rates: SellerEconomicsRates;
}

/** One row of the breakdown, signed the way the ledger records it. */
export interface SellerEconomicsLine {
  key: string;
  label: string;
  /** Positive for money in, negative for a deduction. */
  amountPaise: number;
  /**
   * The ledger entry this line becomes on delivery, or null for lines that
   * are shown but never posted (there are none yet; the field exists so a
   * display-only line cannot be posted by accident).
   */
  ledgerType: SellerLedgerTypeValue | null;
}

export interface SellerEconomics {
  /** What the buyer is charged for this line (shipping is per order, not here). */
  buyerPaysPaise: number;
  grossPaise: number;
  commissionPaise: number;
  gatewayFeePaise: number;
  tdsPaise: number;
  /** What lands in the seller's settlement balance for this line. */
  sellerReceivesPaise: number;
  lines: SellerEconomicsLine[];
}

/** Percent of an amount, rounded to the nearest paisa. */
export function percentOf(amountPaise: number, percent: number): number {
  return Math.round((amountPaise * percent) / 100);
}

export function computeListingEconomics(input: SellerEconomicsInput): SellerEconomics {
  const quantity = Math.max(0, Math.floor(input.quantity ?? 1));
  const price = Math.max(0, Math.round(input.sellerPricePaise));
  const grossPaise = price * quantity;
  const { rates } = input;

  const commissionPaise = percentOf(grossPaise, rates.commissionPercent);
  const gatewayFeePaise = percentOf(grossPaise, rates.gatewayPercent);
  const tdsPaise = percentOf(grossPaise, rates.tdsPercent);

  const lines: SellerEconomicsLine[] = [
    { key: 'sale', label: 'Sale', amountPaise: grossPaise, ledgerType: 'SALE_EARNING' },
    {
      key: 'commission',
      label: `Commission (${rates.commissionPercent}%)`,
      amountPaise: -commissionPaise,
      ledgerType: 'COMMISSION',
    },
    {
      key: 'gateway',
      label: `Payment gateway (${rates.gatewayPercent}%)`,
      amountPaise: -gatewayFeePaise,
      ledgerType: 'GATEWAY_FEE',
    },
    { key: 'tds', label: `TDS 194-O (${rates.tdsPercent}%)`, amountPaise: -tdsPaise, ledgerType: 'TDS' },
  ];

  // The seller's share is the sum of the lines, not a separate formula, so
  // adding a line can never leave the total and the breakdown disagreeing.
  const sellerReceivesPaise = lines.reduce((sum, l) => sum + l.amountPaise, 0);

  return {
    buyerPaysPaise: grossPaise,
    grossPaise,
    commissionPaise,
    gatewayFeePaise,
    tdsPaise,
    sellerReceivesPaise,
    lines,
  };
}
