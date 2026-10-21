import { referralPercentFor, type ReferralFeeSlab, type ReferralFeeSource } from './referralFees';
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
// charged, prices from that. Delivery is free for buyers; the seller pays
// Delhivery's freight per parcel, posted on delivery (not part of a line, so
// not here). GST is the seller's to remit, not a Clowe deduction.
//
// Money is in paise throughout and every component is rounded to a whole
// paisa on its own, so the parts always add up to the whole exactly.
// ---------------------------------------------------------------------------

/** The rates in force. Every one of these is an admin-editable platform setting. */
export interface SellerEconomicsRates {
  /** Marketplace commission, percent of the seller's price (before GST) × quantity. */
  commissionPercent: number;
  /** Payment gateway / collection charge, percent of what the buyer pays (GST included). */
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
  /** Fixed closing fee, per unit. */
  closingFeePaise: number;
  /** Goods transfer (GT) charge, per unit. */
  gtChargePaise: number;
  /**
   * The owner's Batch 2 fees, when they apply (new order lines; the product
   * form's preview): referral, GT and collection as percents of the selling
   * price (GST included), the handling fee per unit by price slab, and GST on
   * each of Clowe's charges. When set, commissionPercent, gatewayPercent and
   * the fixed platform, closing and GT fees above are not used.
   */
  v2?: SellerFeesV2 | null;
}

export interface SellerFeesV2 {
  /**
   * The referral fee as a percent of the full selling price. On an order line
   * it is the rate the line was sold under, fixed at checkout; with
   * referralSlabs (the listing form's preview) it is only the fallback.
   */
  referralPercent: number;
  /** The category's slabs from the fee schedule: the rate follows the unit price. */
  referralSlabs?: ReferralFeeSlab[] | null;
  /** Where an order line's referral rate came from (schedule, category, slab). */
  referralSource?: ReferralFeeSource | null;
  gtPercent: number;
  collectionPercent: number;
  handlingSlabs: { fromPaise: number; feePaise: number }[];
  /** Premium plan or the admin's VIP flag. */
  handlingWaived: boolean;
  /** GST on Clowe's charges. */
  gstPercent: number;
}

export interface SellerEconomicsInput {
  /** The seller's price per unit, BEFORE GST — what the product form takes. */
  sellerPricePaise?: number;
  /**
   * Or what the buyer was charged per unit, GST included — what an order line
   * records. Used when sellerPricePaise is not given.
   */
  buyerPricePaise?: number;
  /** The GST rate the order line was sold at, when it recorded one; else worked out from the rules. */
  gstRatePercent?: number | null;
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
  closingFeePaise: number;
  gtChargePaise: number;
  tdsPaise: number;
  tcsPaise: number;
  /** The line's value net of GST: the base for TDS and TCS. */
  exGstPaise: number;
  /** Batch 2: the handling fee, and the GST on all of Clowe's charges. */
  handlingFeePaise: number;
  cloweFeeGstPaise: number;
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
    gstRatePercent = input.gstRatePercent ?? gstRateForInclusive(unitPaise, rules, rates.gst).ratePercent;
    grossPaise = unitPaise * quantity;
    gstPaise = gstInclusiveShare(grossPaise, gstRatePercent);
  }
  // The seller's price before GST: the base for commission, TDS and TCS. The
  // gateway charges on what it collects, which is what the buyer pays.
  const exGstPaise = grossPaise - gstPaise;
  if (rates.v2) return feesV2({ rates, v2: rates.v2, quantity, grossPaise, gstPaise, gstRatePercent, exGstPaise });
  const commissionPaise = percentOf(exGstPaise, rates.commissionPercent);
  const gatewayFeePaise = percentOf(grossPaise, rates.gatewayPercent);
  const tdsPaise = percentOf(exGstPaise, rates.tdsPercent);
  const tcsPaise = percentOf(exGstPaise, rates.tcsPercent);
  // Fixed fees only exist when something was sold: a zero-quantity line
  // (or a zero price, for the preview) owes nothing.
  const sold = grossPaise > 0;
  const platformFeePaise = sold ? Math.max(0, Math.round(rates.platformFeePaise)) : 0;
  const closingFeePaise = sold ? Math.max(0, Math.round(rates.closingFeePaise)) * quantity : 0;
  const gtChargePaise = sold ? Math.max(0, Math.round(rates.gtChargePaise)) * quantity : 0;

  const lines: SellerEconomicsLine[] = [
    { key: 'sale', label: 'Sale', amountPaise: grossPaise, ledgerType: 'SALE_EARNING' },
    {
      key: 'commission',
      label: `Commission (${rates.commissionPercent}% of your price)`,
      amountPaise: -commissionPaise,
      ledgerType: 'COMMISSION',
    },
    {
      key: 'gateway',
      label: `Payment gateway (${rates.gatewayPercent}% of what the buyer pays)`,
      amountPaise: -gatewayFeePaise,
      ledgerType: 'GATEWAY_FEE',
    },
    { key: 'platform', label: 'Platform fee', amountPaise: -platformFeePaise, ledgerType: 'PLATFORM_FEE' },
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
    { key: 'tds', label: `TDS (${rates.tdsPercent}% of your price)`, amountPaise: -tdsPaise, ledgerType: 'TDS' },
    { key: 'tcs', label: `TCS (${rates.tcsPercent}% of your price)`, amountPaise: -tcsPaise, ledgerType: 'GST_TCS' },
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
    closingFeePaise,
    gtChargePaise,
    tdsPaise,
    tcsPaise,
    exGstPaise,
    handlingFeePaise: 0,
    cloweFeeGstPaise: 0,
    sellerReceivesPaise,
    sellerKeepsAfterGstPaise: sellerReceivesPaise - gstPaise,
    lines,
  };
}

/**
 * Batch 2 (the owner's commercial rules): on the selling price — what the
 * buyer pays for the line, GST included — a referral fee, a GT charge and a
 * payment collection fee as percents, a handling fee per unit by price slab
 * (none on Premium or for a VIP seller), and GST on each of those charges.
 * TDS and TCS are statutory and stay on the price before GST.
 */
function feesV2(input: {
  rates: SellerEconomicsRates;
  v2: SellerFeesV2;
  quantity: number;
  grossPaise: number;
  gstPaise: number;
  gstRatePercent: number;
  exGstPaise: number;
}): SellerEconomics {
  const { rates, v2, quantity, grossPaise, gstPaise, gstRatePercent, exGstPaise } = input;
  const sold = grossPaise > 0;
  const unitPaise = quantity > 0 ? Math.round(grossPaise / quantity) : 0;
  // The slab of the unit price, GST included, sets the rate on the full price.
  const referral = referralPercentFor(v2.referralSlabs, unitPaise, v2.referralPercent);
  const referralPaise = percentOf(grossPaise, referral.percent);
  const gtPaise = percentOf(grossPaise, v2.gtPercent);
  const collectionPaise = percentOf(grossPaise, v2.collectionPercent);
  const sortedSlabs = [...v2.handlingSlabs].sort((a, b) => a.fromPaise - b.fromPaise);
  let perUnit = sortedSlabs[0]?.feePaise ?? 0;
  for (const s of sortedSlabs) if (unitPaise >= s.fromPaise) perUnit = s.feePaise;
  const handlingFeePaise = sold && !v2.handlingWaived ? perUnit * quantity : 0;
  const charges = referralPaise + gtPaise + collectionPaise + handlingFeePaise;
  const cloweFeeGstPaise = Math.round((charges * v2.gstPercent) / 100);
  const tdsPaise = percentOf(exGstPaise, rates.tdsPercent);
  const tcsPaise = percentOf(exGstPaise, rates.tcsPercent);
  const units = quantity > 1 ? ` × ${quantity}` : '';
  const lines: SellerEconomicsLine[] = [
    { key: 'sale', label: 'Sale', amountPaise: grossPaise, ledgerType: 'SALE_EARNING' },
    { key: 'commission', label: `Referral fee (${referral.percent}% of the selling price)`, amountPaise: -referralPaise, ledgerType: 'COMMISSION' },
    { key: 'gt', label: `GT charge (${v2.gtPercent}% of the selling price)`, amountPaise: -gtPaise, ledgerType: 'GT_CHARGE' },
    { key: 'gateway', label: `Payment collection fee (${v2.collectionPercent}% of the selling price)`, amountPaise: -collectionPaise, ledgerType: 'GATEWAY_FEE' },
    {
      key: 'handling',
      label: v2.handlingWaived ? 'Handling fee (waived)' : `Handling fee (₹${perUnit / 100} per unit${units})`,
      amountPaise: -handlingFeePaise,
      ledgerType: 'HANDLING_FEE',
    },
    { key: 'feeGst', label: `GST on Clowe's fees (${v2.gstPercent}%)`, amountPaise: -cloweFeeGstPaise, ledgerType: 'CLOWE_FEE_GST' },
    { key: 'tds', label: `TDS (${rates.tdsPercent}% of your price)`, amountPaise: -tdsPaise, ledgerType: 'TDS' },
    { key: 'tcs', label: `TCS (${rates.tcsPercent}% of your price)`, amountPaise: -tcsPaise, ledgerType: 'GST_TCS' },
  ];
  const sellerReceivesPaise = lines.filter((l) => l.ledgerType !== null).reduce((sum, l) => sum + l.amountPaise, 0);
  return {
    buyerPaysPaise: grossPaise,
    grossPaise,
    gstPaise,
    gstRatePercent,
    commissionPaise: referralPaise,
    gatewayFeePaise: collectionPaise,
    platformFeePaise: 0,
    closingFeePaise: 0,
    gtChargePaise: gtPaise,
    tdsPaise,
    tcsPaise,
    exGstPaise,
    handlingFeePaise,
    cloweFeeGstPaise,
    sellerReceivesPaise,
    sellerKeepsAfterGstPaise: sellerReceivesPaise - gstPaise,
    lines,
  };
}

/**
 * GET /api/seller/pricing-rates/delivery-estimate — what sending one parcel
 * of a product costs the seller, from their pickup pincode. Delhivery bills
 * per 0.5 kg slab, on the greater of actual and volumetric weight.
 */
export interface SellerDeliveryEstimate {
  originPincode: string | null;
  /** The greater of actual and volumetric weight. */
  chargeableGrams: number;
  /** Rounded up to Delhivery's 0.5 kg slab: what is priced. */
  slabGrams: number;
  /** Same city, a metro, somewhere far: the freight for each, GST included. */
  cases: { key: string; label: string; destinationPincode: string; zone: string; freightPaise: number }[];
  /** What a COD order adds: Delhivery's COD fee at this price, GST included. */
  codFeePaise: number | null;
  /** 'mock' while the test courier is in use. */
  provider: string;
  error: string | null;
}

/** How a breakdown row reads: where the money starts, what comes off it, what is left. */
export type BreakdownRowKind = 'start' | 'deduction' | 'total';

export interface BreakdownRow {
  key: string;
  label: string;
  /** Signed: what this row adds to or takes from the running total. Totals are the total. */
  amountPaise: number;
  kind: BreakdownRowKind;
}

/**
 * The breakdown as the seller reads it, top to bottom: what the buyer pays,
 * then GST and every fee and tax in one list of deductions, then what they
 * earn — the sum of the rows above it. What reaches their bank is that plus
 * the GST, which they file themselves (sellerReceivesPaise), and it is what
 * the ledger posts and payouts pay.
 */
export function breakdownRows(e: SellerEconomics): BreakdownRow[] {
  return [
    { key: 'buyer', label: 'Buyer pays', amountPaise: e.buyerPaysPaise, kind: 'start' },
    { key: 'gst', label: `GST (${e.gstRatePercent}%)`, amountPaise: -e.gstPaise, kind: 'deduction' },
    ...e.lines
      .filter((l) => l.key !== 'sale')
      .map((l): BreakdownRow => ({ key: l.key, label: l.label, amountPaise: l.amountPaise, kind: 'deduction' })),
    { key: 'earning', label: 'Your earning', amountPaise: e.sellerKeepsAfterGstPaise, kind: 'total' },
  ];
}
