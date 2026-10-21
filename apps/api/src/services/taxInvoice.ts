import { DEFAULT_LEGAL_ENTITY, gstRateForInclusive, type CreditNote, type TaxInvoice } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { categoryRulesMap } from './categoryRules';
import { gstSettings } from './economicsRates';
import { getSettings } from './settingsService';

/**
 * A seller's tax invoice for their lines of an order.
 *
 * The supplier is the seller — their legal name, GSTIN and address — and
 * Clowe Partners LLP is named as the marketplace (e-commerce operator) the
 * sale went through. Each line is taxed at the rate it was sold at
 * (OrderItem.gstRatePercent), split into CGST + SGST for a same-state supply
 * and IGST otherwise. The seller's copy and the buyer's are built here, so
 * the two always carry the same number and the same figures — and a credit
 * note credits a line at exactly what its invoice charged (invoiceLines).
 *
 * Returns null when the seller has no lines on the order (or only cancelled ones).
 */
export async function buildTaxInvoice(orderId: string, sellerId: string): Promise<TaxInvoice | null> {
  const ctx = await invoiceContext(orderId, sellerId);
  if (!ctx) return null;
  return { ...ctx.header, ...totalsOf(ctx.lines.map((l) => l.line)), lines: ctx.lines.map((l) => l.line), gstRatePercent: ctx.lines[0]!.line.gstRatePercent };
}

type InvoiceLine = TaxInvoice['lines'][number];
type Header = Omit<TaxInvoice, 'lines' | 'gstRatePercent' | 'taxablePaise' | 'gstPaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'totalPaise'>;

/** Everything an invoice of this seller's lines says, and each line with its order item. */
async function invoiceContext(orderId: string, sellerId: string): Promise<{ header: Header; lines: { orderItemId: string; line: InvoiceLine }[] } | null> {
  const [order, seller, settings] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { name: true } },
        payment: { select: { status: true, paidAt: true } },
        // Cancelled lines were never supplied, so they are not invoiced.
        items: { where: { sellerId, status: { not: 'CANCELLED' } }, include: { product: { select: { categoryId: true } } }, orderBy: { id: 'asc' } },
      },
    }),
    prisma.sellerProfile.findUnique({ where: { id: sellerId } }),
    getSettings(),
  ]);
  if (!order || !seller) throw ApiError.notFound('Order not found');
  if (order.items.length === 0) return null;
  // A free replacement is no new sale: the original's invoice stands.
  if (order.paymentMethod === 'REPLACEMENT') return null;
  if (order.status === 'PLACED') throw ApiError.badRequest('This order is not paid yet', 'ORDER_NOT_PAID');

  // GST: the rate the line was sold at; worked out (the category's rule with
  // the admin's GST settings) only for a line that recorded none.
  const taxRules = await categoryRulesMap(order.items.map((i) => i.product.categoryId));
  const gst = gstSettings(settings);
  const isIntraState = !!seller.state && seller.state.trim().toLowerCase() === (order.shipState ?? '').trim().toLowerCase();

  const lines = order.items.map((i) => {
    const gross = i.pricePaise * i.quantity;
    const rules = taxRules.get(i.product.categoryId);
    const rate = i.gstRatePercent ?? gstRateForInclusive(i.pricePaise, rules, gst).ratePercent;
    const taxable = Math.round(gross / (1 + rate / 100));
    const tax = gross - taxable;
    const cgst = isIntraState ? Math.floor(tax / 2) : 0;
    const line: InvoiceLine = {
      title: i.title,
      size: i.size,
      color: i.color,
      variantLabel: i.variantLabel,
      quantity: i.quantity,
      unitPricePaise: i.pricePaise,
      grossPaise: gross,
      taxablePaise: taxable,
      gstPaise: tax,
      gstRatePercent: rate,
      hsnCode: rules?.hsnCode ?? null,
      cgstPaise: cgst,
      sgstPaise: isIntraState ? tax - cgst : 0,
      igstPaise: isIntraState ? 0 : tax,
    };
    return { orderItemId: i.id, line };
  });

  const legal = { ...DEFAULT_LEGAL_ENTITY, ...settings.legalEntity };
  // The invoice is dated when the order was confirmed — paid, or for Cash on
  // Delivery placed — and reads the same on every view. (It was "now", so
  // every download carried a different date.)
  const confirmedAt = order.paymentMethod !== 'COD' && order.payment?.paidAt ? order.payment.paidAt : order.createdAt;
  const header: Header = {
    invoiceNumber: invoiceNumberOf(order.orderNumber, seller.id),
    issuedAt: confirmedAt.toISOString(),
    orderNumber: order.orderNumber,
    placedAt: order.createdAt.toISOString(),
    paymentMethod: order.paymentMethod,
    paymentStatus: order.payment?.status ?? (order.paymentMethod === 'COD' ? 'COD_PENDING' : 'CREATED'),
    seller: {
      shopName: seller.shopName,
      legalName: seller.panName?.trim() || seller.shopName,
      line1: seller.addressLine1,
      city: seller.city,
      state: seller.state,
      pincode: seller.pincode,
      gstNumber: seller.gstNumber,
      panNumber: seller.panNumber,
    },
    marketplace: {
      name: legal.name,
      gstin: legal.gstin.trim() || null,
      address: legal.registeredAddress.trim() || null,
    },
    buyerGstin: order.buyerGstin ?? null,
    billTo: {
      name: order.billName ?? order.shipName,
      line1: order.billLine1 ?? order.shipLine1,
      line2: order.billLine2 ?? order.shipLine2,
      city: order.billCity ?? order.shipCity,
      state: order.billState ?? order.shipState,
      pincode: order.billPincode ?? order.shipPincode,
    },
    customer: { name: order.user.name ?? order.shipName },
    isIntraState,
  };
  return { header, lines };
}

/** INV-<order number>-<last 4 of the seller id>: one invoice per seller per order. */
export function invoiceNumberOf(orderNumber: string, sellerId: string): string {
  return `INV-${orderNumber}-${sellerId.slice(-4).toUpperCase()}`;
}

function totalsOf(lines: InvoiceLine[]) {
  const sum = (key: 'taxablePaise' | 'gstPaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise') => lines.reduce((s, l) => s + l[key], 0);
  return {
    taxablePaise: sum('taxablePaise'),
    gstPaise: sum('gstPaise'),
    cgstPaise: sum('cgstPaise'),
    sgstPaise: sum('sgstPaise'),
    igstPaise: sum('igstPaise'),
    totalPaise: sum('taxablePaise') + sum('gstPaise'),
  };
}

/**
 * The credit note for some of a seller's invoiced lines: the invoice's own
 * header, those lines at the invoice's figures, and what it reduces. Null
 * when there is no invoice to reduce (an unpaid order, a free replacement) or
 * none of the lines is on it.
 */
export async function buildCreditNote(input: {
  orderId: string;
  sellerId: string;
  orderItemIds: string[];
  creditNoteNumber: string;
  issuedAt: Date;
  reason: string;
}): Promise<CreditNote | null> {
  const ctx = await invoiceContext(input.orderId, input.sellerId).catch((err) => {
    if (err instanceof ApiError && err.code === 'ORDER_NOT_PAID') return null;
    throw err;
  });
  if (!ctx) return null;
  const lines = ctx.lines.filter((l) => input.orderItemIds.includes(l.orderItemId)).map((l) => l.line);
  if (lines.length === 0) return null;
  const h = ctx.header;
  return {
    creditNoteNumber: input.creditNoteNumber,
    issuedAt: input.issuedAt.toISOString(),
    reason: input.reason,
    original: { invoiceNumber: h.invoiceNumber, issuedAt: h.issuedAt },
    orderNumber: h.orderNumber,
    seller: h.seller,
    marketplace: h.marketplace,
    billTo: h.billTo,
    buyerGstin: h.buyerGstin,
    isIntraState: h.isIntraState,
    lines,
    ...totalsOf(lines),
  };
}
