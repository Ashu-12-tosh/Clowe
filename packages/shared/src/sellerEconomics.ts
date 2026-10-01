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
// The price a seller lists is the price the buyer is charged for the item,
// GST included — that is how the catalog, checkout and the tax invoice
// already treat it. Shipping is charged per order at checkout and is not part
// of a line. So buyerPays = price × quantity, and GST is shown as the part of
// that price the seller remits, not as a Clowe deduction.
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
  /**
   * GST contained in the listed price, percent. One platform-wide rate for
   * now; category-wise GST (books 0%, apparel under ₹1,000 at 5%) is a known
   * follow-up, and the tax invoice already applies those category rules.
   */
  gstPercent: number;
  /** Fixed platform fee, per order line. */
  platformFeePaise: number;
  /** Fixed delivery fee charged to the seller, per shipment (one per line). */
  deliveryFeePaise: number;
  /** Fixed closing fee, per unit. */
  closingFeePaise: number;
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
   * The ledger entry this line becomes on delivery, or null for a line that
   * is shown but never posted — GST, which the seller remits themselves and
   * Clowe never withholds.
   */
  ledgerType: SellerLedgerTypeValue | null;
}

export interface SellerEconomics {
  /** What the buyer is charged for this line (shipping is per order, not here). */
  buyerPaysPaise: number;
  grossPaise: number;
  /** GST inside the price at the platform rate; the seller's to remit. */
  gstPaise: number;
  commissionPaise: number;
  gatewayFeePaise: number;
  platformFeePaise: number;
  deliveryFeePaise: number;
  closingFeePaise: number;
  tdsPaise: number;
  /** What Clowe settles to the seller for this line: gross less every deduction. */
  sellerReceivesPaise: number;
  /** sellerReceives less the GST they remit — the seller's real take. */
  sellerKeepsAfterGstPaise: number;
  lines: SellerEconomicsLine[];
}

/** Percent of an amount, rounded to the nearest paisa. */
export function percentOf(amountPaise: number, percent: number): number {
  return Math.round((amountPaise * percent) / 100);
}

/** The GST contained in a GST-inclusive amount, rounded to the nearest paisa. */
export function gstInclusiveShare(amountPaise: number, gstPercent: number): number {
  if (gstPercent <= 0) return 0;
  return amountPaise - Math.round(amountPaise / (1 + gstPercent / 100));
}

export function computeListingEconomics(input: SellerEconomicsInput): SellerEconomics {
  const quantity = Math.max(0, Math.floor(input.quantity ?? 1));
  const price = Math.max(0, Math.round(input.sellerPricePaise));
  const grossPaise = price * quantity;
  const { rates } = input;

  const gstPaise = gstInclusiveShare(grossPaise, rates.gstPercent);
  const commissionPaise = percentOf(grossPaise, rates.commissionPercent);
  const gatewayFeePaise = percentOf(grossPaise, rates.gatewayPercent);
  const tdsPaise = percentOf(grossPaise, rates.tdsPercent);
  // Fixed fees only exist when something was sold: a zero-quantity line
  // (or a zero price, for the preview) owes nothing.
  const sold = grossPaise > 0;
  const platformFeePaise = sold ? Math.max(0, Math.round(rates.platformFeePaise)) : 0;
  const deliveryFeePaise = sold ? Math.max(0, Math.round(rates.deliveryFeePaise)) : 0;
  const closingFeePaise = sold ? Math.max(0, Math.round(rates.closingFeePaise)) * quantity : 0;

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
    { key: 'platform', label: 'Platform fee', amountPaise: -platformFeePaise, ledgerType: 'PLATFORM_FEE' },
    { key: 'delivery', label: 'Delivery fee', amountPaise: -deliveryFeePaise, ledgerType: 'DELIVERY_FEE' },
    {
      key: 'closing',
      label: quantity > 1 ? `Closing fee (${quantity} units)` : 'Closing fee',
      amountPaise: -closingFeePaise,
      ledgerType: 'CLOSING_FEE',
    },
    { key: 'tds', label: `TDS 194-O (${rates.tdsPercent}%)`, amountPaise: -tdsPaise, ledgerType: 'TDS' },
  ];

  // The seller's share is the sum of the posted lines, not a separate formula,
  // so adding a line can never leave the total and the breakdown disagreeing.
  const sellerReceivesPaise = lines
    .filter((l) => l.ledgerType !== null)
    .reduce((sum, l) => sum + l.amountPaise, 0);

  return {
    buyerPaysPaise: grossPaise,
    grossPaise,
    gstPaise,
    commissionPaise,
    gatewayFeePaise,
    platformFeePaise,
    deliveryFeePaise,
    closingFeePaise,
    tdsPaise,
    sellerReceivesPaise,
    sellerKeepsAfterGstPaise: sellerReceivesPaise - gstPaise,
    lines,
  };
}
