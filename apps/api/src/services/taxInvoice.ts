import { DEFAULT_LEGAL_ENTITY, gstRateForInclusive, type TaxInvoice } from '@clowe/shared';
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
 * the two always carry the same number and the same figures.
 *
 * Returns null when the seller has no lines on the order (or only cancelled ones).
 */
export async function buildTaxInvoice(orderId: string, sellerId: string): Promise<TaxInvoice | null> {
  const [order, seller, settings] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { name: true } },
        payment: { select: { status: true } },
        // Cancelled lines were never supplied, so they are not invoiced.
        items: { where: { sellerId, status: { not: 'CANCELLED' } }, include: { product: { select: { categoryId: true } } } },
      },
    }),
    prisma.sellerProfile.findUnique({ where: { id: sellerId } }),
    getSettings(),
  ]);
  if (!order || !seller) throw ApiError.notFound('Order not found');
  if (order.items.length === 0) return null;
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
    return {
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
  });
  const sum = (key: 'taxablePaise' | 'gstPaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise') =>
    lines.reduce((s, l) => s + l[key], 0);

  const legal = { ...DEFAULT_LEGAL_ENTITY, ...settings.legalEntity };
  return {
    invoiceNumber: `INV-${order.orderNumber}-${seller.id.slice(-4).toUpperCase()}`,
    issuedAt: new Date().toISOString(),
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
    lines,
    gstRatePercent: lines[0]!.gstRatePercent,
    taxablePaise: sum('taxablePaise'),
    gstPaise: sum('gstPaise'),
    isIntraState,
    cgstPaise: sum('cgstPaise'),
    sgstPaise: sum('sgstPaise'),
    igstPaise: sum('igstPaise'),
    totalPaise: sum('taxablePaise') + sum('gstPaise'),
  };
}
