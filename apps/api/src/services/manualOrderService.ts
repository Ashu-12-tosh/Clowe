import { COD_MAX_PAISE, type ManualPaymentMethod } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { deliveryPriceFor, etaWindowFor } from './deliveryService';
import { confirmCodOrder, generateOrderNumber, settlePaymentSuccess } from './orderService';
import { allocateForDispatch } from './stockService';

/**
 * An order an admin places for a shopper — the phone order.
 *
 * It deliberately walks the same path as a storefront checkout: stock is
 * reserved with the same conditional decrement, the warehouse ledger records
 * the dispatch, and the order is settled through `confirmCodOrder` /
 * `settlePaymentSuccess` so sellers are notified, credits are granted and
 * payouts are raised exactly as usual. The only differences are that it skips
 * the cart and records who placed it.
 *
 * Coupons, credits and seller promotions are NOT applied — an admin taking an
 * order over the phone charges list price, and silently applying a promotion
 * would make the money in the order disagree with what was quoted.
 */
export async function createManualOrder(input: {
  userId: string;
  addressId: string;
  paymentMethod: ManualPaymentMethod;
  deliveryMethod: 'STANDARD' | 'EXPRESS';
  adminNote?: string;
  adminId: string;
  items: { variantId: string; quantity: number }[];
}): Promise<{ id: string; orderNumber: string; totalPaise: number }> {
  const [user, address] = await Promise.all([
    prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, isActive: true, isPremium: true },
    }),
    prisma.address.findUnique({ where: { id: input.addressId } }),
  ]);
  if (!user) throw ApiError.notFound('Customer not found');
  if (!user.isActive) throw ApiError.badRequest('That customer account is disabled');
  if (!address || address.userId !== user.id) {
    throw ApiError.badRequest('That address does not belong to the customer');
  }

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: input.items.map((i) => i.variantId) } },
    select: {
      id: true,
      size: true,
      color: true,
      sku: true,
      pricePaise: true,
      stock: true,
      product: { select: { id: true, title: true, sellerId: true, status: true } },
    },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));

  const lines = input.items.map((item) => {
    const variant = byId.get(item.variantId);
    if (!variant) throw ApiError.badRequest(`Unknown variant ${item.variantId}`);
    if (variant.product.status !== 'APPROVED') {
      throw ApiError.badRequest(`"${variant.product.title}" is not on sale`, 'NOT_PURCHASABLE');
    }
    if (variant.stock < item.quantity) {
      throw ApiError.badRequest(
        `"${variant.product.title}" (${variant.color}/${variant.size}) has only ${variant.stock} left`,
        'OUT_OF_STOCK',
      );
    }
    return {
      variantId: variant.id,
      productId: variant.product.id,
      sellerId: variant.product.sellerId,
      title: variant.product.title,
      size: variant.size,
      color: variant.color,
      pricePaise: variant.pricePaise,
      quantity: item.quantity,
    };
  });

  const subtotalPaise = lines.reduce((sum, l) => sum + l.pricePaise * l.quantity, 0);
  const shippingPaise = deliveryPriceFor(input.deliveryMethod, subtotalPaise, user.isPremium);
  const totalPaise = subtotalPaise + shippingPaise;
  const eta = etaWindowFor(input.deliveryMethod);
  const orderNumber = await generateOrderNumber();

  // The COD rules a shopper faces at checkout apply to a phone order too —
  // the cap and each seller's own opt-out.
  if (input.paymentMethod === 'COD') {
    if (totalPaise > COD_MAX_PAISE) {
      throw ApiError.badRequest(
        `Cash on Delivery is available up to ₹${COD_MAX_PAISE / 100}`,
        'COD_NOT_ELIGIBLE',
      );
    }
    const noCod = await prisma.sellerProfile.findFirst({
      where: { id: { in: [...new Set(lines.map((l) => l.sellerId))] }, codEnabled: false },
      select: { shopName: true },
    });
    if (noCod) {
      throw ApiError.badRequest(
        `${noCod.shopName} does not accept Cash on Delivery — take payment another way`,
        'COD_NOT_ELIGIBLE',
      );
    }
  }

  const order = await prisma.$transaction(async (tx) => {
    for (const line of lines) {
      const updated = await tx.productVariant.updateMany({
        where: { id: line.variantId, stock: { gte: line.quantity } },
        data: { stock: { decrement: line.quantity } },
      });
      if (updated.count === 0) {
        throw ApiError.badRequest(`"${line.title}" just went out of stock`, 'OUT_OF_STOCK');
      }
      await allocateForDispatch(tx, {
        variantId: line.variantId,
        quantity: line.quantity,
        reference: orderNumber,
        actorId: input.adminId,
      });
    }

    return tx.order.create({
      data: {
        orderNumber,
        userId: user.id,
        addressId: address.id,
        shipName: address.name,
        shipPhone: address.phone,
        shipLine1: address.line1,
        shipLine2: address.line2,
        shipCity: address.city,
        shipState: address.state,
        shipPincode: address.pincode,
        status: 'PLACED',
        subtotalPaise,
        shippingPaise,
        discountPaise: 0,
        creditsUsed: 0,
        couponDiscountPaise: 0,
        totalPaise,
        deliveryMethod: input.deliveryMethod,
        etaFrom: eta.from,
        etaTo: eta.to,
        paymentMethod: input.paymentMethod,
        billName: address.name,
        billLine1: address.line1,
        billLine2: address.line2,
        billCity: address.city,
        billState: address.state,
        billPincode: address.pincode,
        placedByAdminId: input.adminId,
        adminNote: input.adminNote || null,
        items: {
          create: lines.map((l) => ({
            productId: l.productId,
            variantId: l.variantId,
            sellerId: l.sellerId,
            title: l.title,
            size: l.size,
            color: l.color,
            pricePaise: l.pricePaise,
            quantity: l.quantity,
            status: 'PLACED',
          })),
        },
      },
    });
  });

  if (input.paymentMethod === 'COD') {
    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'cod',
        providerOrderId: `cod_${order.orderNumber}`,
        amountPaise: totalPaise,
        status: 'CREATED',
      },
    });
    await confirmCodOrder(order.id);
  } else {
    // The admin collected the money outside the gateway (UPI to the store,
    // card machine, bank transfer). Recording it as paid by "manual" keeps the
    // provider column honest about where it actually came from.
    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'manual',
        providerOrderId: `manual_${order.orderNumber}`,
        amountPaise: totalPaise,
        status: 'CREATED',
      },
    });
    await settlePaymentSuccess(order.id, `manual_${input.paymentMethod.toLowerCase()}`);
  }

  return { id: order.id, orderNumber: order.orderNumber, totalPaise };
}
