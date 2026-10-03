import { buyerPriceFor, gstRateForInclusive, type CategoryRules, type GstSettings } from './categoryRules';
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
// Sellers enter their price BEFORE GST; the buyer pays it plus GST at the
// category's rate (buyerPriceFor), and the catalog, checkout and the tax
// invoice show and charge that GST-inclusive price. The product form prices
// from the seller's number; an order line, which records what the buyer was
// charged, prices from that. Shipping is charged per order at checkout and
// is not part of a line. GST is the seller's to remit, not a Clowe deduction.
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
  /**
   * Section 194-O TDS withheld, percent of the line's value EX-GST: CBDT
   * Circular 20/2023 excludes GST shown separately on the invoice when TDS is
   * deducted at credit, which is when the ledger posts it (on delivery).
   */
  tdsPercent: number;
  /** GST TCS collected under s.52 CGST Act, percent of the line's value ex-GST. */
  tcsPercent: number;
  /**
   * GST settings. The rate itself is never a single platform number: it
   * comes from the product's category rules and these, through
   * gstRateForExGst (a seller's price) or gstRateForInclusive (an order line).
   */
  gst: GstSettings;
  /** Fixed platform fee, per order line. */
  platformFeePaise: number;
  /** Fixed delivery fee charged to the seller, per shipment (one per line). */
  deliveryFeePaise: number;
  /** Fixed closing fee, per unit. */
  closingFeePaise: number;
  /** Goods transfer (GT) charge, per unit. */
  gtChargePaise: number;
}

export interface SellerEconomicsInput {
  /** The seller's price per unit, BEFORE GST — what the product form takes. */
  sellerPricePaise?: number;
  /**
   * Or what the buyer was charged per unit, GST included — what an order line
   * records. Used when sellerPricePaise is not given.
   */
  buyerPricePaise?: number;
  /** Units on the line; defaults to one for the listing preview. */
  quantity?: number;
  rates: SellerEconomicsRates;
  /** The product's category GST rule; null before a category is chosen (standard rate). */
  taxRules?: Pick<CategoryRules, 'taxRule' | 'defaultTaxRatePercent'> | null;
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
  /** GST inside the price, at the rate for this product and price; the seller's to remit. */
  gstPaise: number;
  /** The rate that applied. */
  gstRatePercent: number;
  commissionPaise: number;
  gatewayFeePaise: number;
  platformFeePaise: number;
  deliveryFeePaise: number;
  closingFeePaise: number;
  gtChargePaise: number;
  tdsPaise: number;
  tcsPaise: number;
  /** The line's value net of GST: the base for TDS and TCS. */
  exGstPaise: number;
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
  const { rates } = input;
  const rules = input.taxRules ?? null;

  // From the seller's price: GST per unit on top of it. From an order line:
  // the GST inside what the buyer paid, on the line total as the invoice has it.
  let grossPaise: number;
  let gstPaise: number;
  let gstRatePercent: number;
  if (input.sellerPricePaise !== undefined) {
    const unit = buyerPriceFor(Math.max(0, Math.round(input.sellerPricePaise)), rules, rates.gst);
    grossPaise = unit.buyerPaise * quantity;
    gstPaise = unit.gstPaise * quantity;
    gstRatePercent = unit.ratePercent;
  } else {
    const unitPaise = Math.max(0, Math.round(input.buyerPricePaise ?? 0));
    gstRatePercent = gstRateForInclusive(unitPaise, rules, rates.gst).ratePercent;
    grossPaise = unitPaise * quantity;
    gstPaise = gstInclusiveShare(grossPaise, gstRatePercent);
  }
  const commissionPaise = percentOf(grossPaise, rates.commissionPercent);
  const gatewayFeePaise = percentOf(grossPaise, rates.gatewayPercent);
  // TDS and TCS are levied on the value net of GST, not on what the buyer paid.
  const exGstPaise = grossPaise - gstPaise;
  const tdsPaise = percentOf(exGstPaise, rates.tdsPercent);
  const tcsPaise = percentOf(exGstPaise, rates.tcsPercent);
  // Fixed fees only exist when something was sold: a zero-quantity line
  // (or a zero price, for the preview) owes nothing.
  const sold = grossPaise > 0;
  const platformFeePaise = sold ? Math.max(0, Math.round(rates.platformFeePaise)) : 0;
  const deliveryFeePaise = sold ? Math.max(0, Math.round(rates.deliveryFeePaise)) : 0;
  const closingFeePaise = sold ? Math.max(0, Math.round(rates.closingFeePaise)) * quantity : 0;
  const gtChargePaise = sold ? Math.max(0, Math.round(rates.gtChargePaise)) * quantity : 0;

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
    {
      key: 'gt',
      label: quantity > 1 ? `GT charge (${quantity} units)` : 'GT charge',
      amountPaise: -gtChargePaise,
      ledgerType: 'GT_CHARGE',
    },
    { key: 'tds', label: `TDS (${rates.tdsPercent}%)`, amountPaise: -tdsPaise, ledgerType: 'TDS' },
    { key: 'tcs', label: `TCS (${rates.tcsPercent}%)`, amountPaise: -tcsPaise, ledgerType: 'GST_TCS' },
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
    gstRatePercent,
    commissionPaise,
    gatewayFeePaise,
    platformFeePaise,
    deliveryFeePaise,
    closingFeePaise,
    gtChargePaise,
    tdsPaise,
    tcsPaise,
    exGstPaise,
    sellerReceivesPaise,
    sellerKeepsAfterGstPaise: sellerReceivesPaise - gstPaise,
    lines,
  };
}

/**
 * How a breakdown row reads: where the money starts, what the platform
 * deducts, the running totals, and the GST the seller remits — tax they owe
 * the government, not a charge, so a screen can set it apart.
 */
export type BreakdownRowKind = 'start' | 'deduction' | 'subtotal' | 'tax' | 'total';

export interface BreakdownRow {
  key: string;
  label: string;
  /** Signed: what this row adds to or takes from the running total. Totals are the total. */
  amountPaise: number;
  kind: BreakdownRowKind;
}

/**
 * The breakdown as the seller reads it, top to bottom: buyer pays, each
 * deduction, what reaches the bank, the GST they remit, what they earn.
 * Every running total is the sum of the rows above it.
 */
export function breakdownRows(e: SellerEconomics): BreakdownRow[] {
  return [
    { key: 'buyer', label: 'Buyer pays', amountPaise: e.buyerPaysPaise, kind: 'start' },
    ...e.lines
      .filter((l) => l.key !== 'sale')
      .map((l): BreakdownRow => ({ key: l.key, label: l.label, amountPaise: l.amountPaise, kind: 'deduction' })),
    { key: 'bank', label: 'Paid to your bank', amountPaise: e.sellerReceivesPaise, kind: 'subtotal' },
    { key: 'gst', label: `GST you remit (${e.gstRatePercent}%)`, amountPaise: -e.gstPaise, kind: 'tax' },
    { key: 'earning', label: 'Your earning', amountPaise: e.sellerKeepsAfterGstPaise, kind: 'total' },
  ];
}
