import { orderEtaWindow } from '@clowe/shared';
import { prisma } from '../db';
import { generateOrderNumber } from './orderService';
import { valueOfLines } from './shipping/codAmount';
import { allocateForDispatch } from './stockService';

// ---------------------------------------------------------------------------
// A free replacement: the same items sent again on a new order, for a parcel
// lost in transit (Shipping Policy 9.2) or an exchange (Return Policy).
//
// The new order is CONFIRMED straight away and goes to the seller like any
// other (the 18-hour dispatch SLA applies; the seller pays the freight).
// Each new line points at the line it replaces (replacementOfId).
//
// What the buyer owes for it: nothing when the original was paid for — a
// prepaid order, or a COD parcel that was delivered and paid in cash; such a
// replacement is paid with REPLACEMENT (total ₹0). A COD parcel that never
// arrived was never paid, so its replacement is COD for the same amount.
//
// The seller is paid for a sale once: a replacement for a line that was
// delivered (an exchange) posts nothing on delivery (sellerLedgerService);
// one for a line never delivered (lost) is the sale.
// ---------------------------------------------------------------------------

export const REPLACEMENT_PAYMENT_METHOD = 'REPLACEMENT';

class OutOfStock extends Error {}

export interface ReplacementResult {
  orderId: string;
  orderNumber: string;
  amountDuePaise: number;
}

/**
 * Send these lines of an order again. Returns null — creating nothing — when
 * any of them is out of stock (the caller refunds instead).
 */
export async function createReplacementOrder(input: {
  orderId: string;
  itemIds: string[];
  reason: string;
  actorId?: string | null;
  /**
   * False: the same unit goes back to the buyer (a claim that failed quality
   * check, Return Policy 4.3) — no stock is taken, and the buyer owes nothing.
   */
  fromStock?: boolean;
}): Promise<ReplacementResult | null> {
  const fromStock = input.fromStock ?? true;
  const original = await prisma.order.findUniqueOrThrow({
    where: { id: input.orderId },
    include: { items: true, payment: true },
  });
  const lines = original.items.filter((i) => input.itemIds.includes(i.id));
  if (lines.length === 0) return null;

  const prepaidPaid = original.paymentMethod !== 'COD' && original.payment?.status === 'PAID';
  const paidFor = (l: (typeof lines)[number]) => prepaidPaid || original.paymentMethod === REPLACEMENT_PAYMENT_METHOD || !!l.deliveredAt;
  const unpaid = lines.filter((l) => !paidFor(l));
  const amountDuePaise =
    fromStock && unpaid.length ? valueOfLines(original.totalPaise, original.items, unpaid.map((l) => l.id)) : 0;
  const method = amountDuePaise > 0 ? 'COD' : REPLACEMENT_PAYMENT_METHOD;
  const orderNumber = await generateOrderNumber();
  const eta = orderEtaWindow(original.shipPincode);

  const created = await prisma.$transaction(async (tx) => {
    for (const l of fromStock ? lines : []) {
      const took = await tx.productVariant.updateMany({
        where: { id: l.variantId, stock: { gte: l.quantity } },
        data: { stock: { decrement: l.quantity } },
      });
      // Thrown, so the units already taken for earlier lines go back.
      if (took.count === 0) throw new OutOfStock();
      await allocateForDispatch(tx, { variantId: l.variantId, quantity: l.quantity, reference: orderNumber, actorId: input.actorId ?? null });
    }
    const order = await tx.order.create({
      data: {
        orderNumber,
        userId: original.userId,
        addressId: original.addressId,
        shipName: original.shipName,
        shipPhone: original.shipPhone,
        shipLine1: original.shipLine1,
        shipLine2: original.shipLine2,
        shipCity: original.shipCity,
        shipState: original.shipState,
        shipPincode: original.shipPincode,
        billName: original.billName,
        billLine1: original.billLine1,
        billLine2: original.billLine2,
        billCity: original.billCity,
        billState: original.billState,
        billPincode: original.billPincode,
        buyerGstin: original.buyerGstin,
        status: 'CONFIRMED',
        subtotalPaise: amountDuePaise,
        shippingPaise: 0,
        totalPaise: amountDuePaise,
        deliveryMethod: 'STANDARD',
        etaFrom: eta.from,
        etaTo: eta.to,
        paymentMethod: method,
        items: {
          create: lines.map((l) => ({
            productId: l.productId,
            variantId: l.variantId,
            sellerId: l.sellerId,
            title: l.title,
            size: l.size,
            color: l.color,
            variantLabel: l.variantLabel,
            optionValues: l.optionValues ?? {},
            pricePaise: l.pricePaise,
            quantity: l.quantity,
            status: 'CONFIRMED',
            returnWindowDays: l.returnWindowDays,
            returnable: l.returnable,
            gstRatePercent: l.gstRatePercent,
            // A replacement is sold under the original line's fees.
            feeModel: l.feeModel,
            feeRates: l.feeRates ?? undefined,
            replacementOfId: l.id,
          })),
        },
        payment: {
          create:
            method === 'COD'
              ? { provider: 'cod', providerOrderId: `cod_${orderNumber}`, amountPaise: amountDuePaise, status: 'CREATED' }
              : { provider: 'replacement', providerOrderId: `rep_${orderNumber}`, amountPaise: 0, status: 'PAID', paidAt: new Date() },
        },
      },
    });
    return order;
  }).catch((err: unknown) => {
    if (err instanceof OutOfStock) return null;
    throw err;
  });
  if (!created) return null;

  const sellers = await prisma.sellerProfile.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.sellerId))] } },
    select: { userId: true },
  });
  await prisma.notification.createMany({
    data: [
      {
        userId: original.userId,
        type: 'ORDER_CONFIRMED',
        title: fromStock ? `Replacement on its way — ${orderNumber}` : `Your item is coming back to you — ${orderNumber}`,
        body: fromStock
          ? `${input.reason}: we're sending ${lines.map((l) => `"${l.title}"`).join(', ')} again as order ${orderNumber}` +
            (amountDuePaise > 0 ? `, Cash on Delivery ₹${(amountDuePaise / 100).toLocaleString('en-IN')} as before.` : ', at no cost to you.')
          : `${input.reason}: ${lines.map((l) => `"${l.title}"`).join(', ')} is being sent back to you as order ${orderNumber}, at no cost.`,
        linkHref: `/account/orders/${created.id}`,
      },
      ...sellers.map((s) => ({
        userId: s.userId,
        type: 'NEW_ORDER',
        title: fromStock ? 'Replacement to ship 🔁' : 'Send a returned item back ↩',
        body: fromStock
          ? `${input.reason} (order ${original.orderNumber}): send the same items again as ${orderNumber}. Dispatch as usual.`
          : `${input.reason} (order ${original.orderNumber}): send the returned item back to the buyer as ${orderNumber}. Dispatch as usual.`,
        linkHref: '/seller/orders',
      })),
    ],
  });
  return { orderId: created.id, orderNumber, amountDuePaise };
}
