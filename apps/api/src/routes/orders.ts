import { Router } from 'express';
import { z } from 'zod';
import type { OrderStatus } from '@prisma/client';
import {
  ORDER_FILTERS,
  type OrderFilter,
  type OrderListResponse,
  checkoutSchema,
  creditsToPaise,
  CREDIT_VALUE_PAISE,
  returnRequestSchema,
  COD_MAX_PAISE,
  EMI_MIN_PAISE,
  type CheckoutResult,
  type OrderDetailView,
  type OrderListRow,
} from '@clowe/shared';
import { prisma } from '../db';
import { getSettings } from '../services/settingsService';
import { recordRedemptions } from '../services/promotionService';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { paymentProvider } from '../services/payments';
import { buildCartView } from './cart';
import { deliveryPriceFor, etaWindowFor, isDeliveryMethodAvailable } from '../services/deliveryService';
import { confirmCodOrder, generateOrderNumber } from '../services/orderService';
import { nextRmaNumber } from '../services/returnService';
import { allocateForDispatch, returnStock } from '../services/stockService';
import { creditExpiryFrom } from './credits';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Checkout: cart → order (stock reserved) + gateway order
// ---------------------------------------------------------------------------

ordersRouter.post('/checkout', async (req, res, next) => {
  try {
    // Sellers/admins can browse the store from their dashboards, but buying
    // is customer-only.
    if (req.auth!.role !== 'CUSTOMER') {
      throw ApiError.forbidden(
        'Seller/admin accounts can view the store but cannot purchase',
        'PURCHASE_CUSTOMER_ONLY',
      );
    }
    const {
      addressId,
      useCredits,
      deliveryMethod,
      isGift,
      giftMessage,
      paymentMethod,
      billingAddressId,
    } = checkoutSchema.parse(req.body);
    const userId = req.auth!.userId;

    if (!isDeliveryMethodAvailable(deliveryMethod)) {
      throw ApiError.badRequest(
        'That delivery speed is no longer available — pick another',
        'DELIVERY_UNAVAILABLE',
      );
    }

    const address = await prisma.address.findUnique({ where: { id: addressId } });
    if (!address || address.userId !== userId) throw ApiError.badRequest('Address not found');

    // Billing defaults to the shipping address unless another saved one is picked.
    let billing = address;
    if (billingAddressId && billingAddressId !== addressId) {
      const picked = await prisma.address.findUnique({ where: { id: billingAddressId } });
      if (!picked || picked.userId !== userId) {
        throw ApiError.badRequest('Billing address not found');
      }
      billing = picked;
    }

    const cart = await buildCartView(userId);
    // Only ticked lines are bought; the rest stay in the cart for later.
    const orderLines = cart.lines.filter((l) => l.selected);
    if (orderLines.length === 0) {
      throw ApiError.badRequest('Select at least one item to checkout', 'CART_EMPTY');
    }

    // Re-check stock at checkout time.
    for (const line of orderLines) {
      if (line.stock < line.quantity) {
        throw ApiError.badRequest(
          `"${line.title}" (${line.color}/${line.size}) has only ${line.stock} left`,
          'OUT_OF_STOCK',
        );
      }
    }

    // Variant → seller mapping for order items.
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: orderLines.map((l) => l.variantId) } },
      include: { product: { select: { sellerId: true } } },
    });
    const sellerByVariant = new Map(variants.map((v) => [v.id, v.product.sellerId]));

    const orderNumber = await generateOrderNumber();
    const subtotalPaise = cart.subtotalPaise;
    // Shipping follows the chosen speed, priced server-side.
    const member = await prisma.user.findUnique({
      where: { id: userId },
      select: { isPremium: true },
    });
    const shippingPaise = deliveryPriceFor(deliveryMethod, subtotalPaise, member?.isPremium ?? false);
    const eta = etaWindowFor(deliveryMethod);

    // Coupon: re-validated here, so a code that expired between the cart page
    // and payment simply doesn't apply rather than silently under-charging.
    const couponDiscountPaise = cart.couponDiscountPaise;
    const couponCode = cart.coupon?.code ?? null;

    // Optional shopping-credits discount (user's choice at the payment step).
    // Redeemable up to the order value minus ₹1 (gateways need a payable amount).
    let creditsUsed = 0;
    if (useCredits) {
      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { creditsBalance: true },
      });
      const maxDiscountPaise = Math.max(
        0,
        subtotalPaise + shippingPaise - couponDiscountPaise - 100,
      );
      creditsUsed = Math.min(me?.creditsBalance ?? 0, Math.floor(maxDiscountPaise / CREDIT_VALUE_PAISE));
    }
    const discountPaise = creditsToPaise(creditsUsed) + couponDiscountPaise;
    const totalPaise = subtotalPaise + shippingPaise - discountPaise;

    // Method-specific eligibility, checked server-side so the UI can't skip it.
    if (paymentMethod === 'EMI' && totalPaise < EMI_MIN_PAISE) {
      throw ApiError.badRequest(
        `EMI is available on orders of ₹${EMI_MIN_PAISE / 100} and above`,
        'EMI_NOT_ELIGIBLE',
      );
    }
    if (paymentMethod === 'COD' && totalPaise > COD_MAX_PAISE) {
      throw ApiError.badRequest(
        `Cash on Delivery is available up to ₹${COD_MAX_PAISE / 100}`,
        'COD_NOT_ELIGIBLE',
      );
    }
    // Sellers may switch COD off for their own goods in Store Settings.
    if (paymentMethod === 'COD') {
      const noCod = await prisma.sellerProfile.findFirst({
        where: { id: { in: [...new Set(sellerByVariant.values())] }, codEnabled: false },
        select: { shopName: true },
      });
      if (noCod) {
        throw ApiError.badRequest(
          `${noCod.shopName} does not accept Cash on Delivery — please pay online for this order`,
          'COD_NOT_ELIGIBLE',
        );
      }
    }

    // Create the order and reserve stock atomically. Conditional decrements
    // guard against a concurrent checkout taking the last unit.
    const order = await prisma.$transaction(async (tx) => {
      for (const line of orderLines) {
        const updated = await tx.productVariant.updateMany({
          where: { id: line.variantId, stock: { gte: line.quantity } },
          data: { stock: { decrement: line.quantity } },
        });
        if (updated.count === 0) {
          throw ApiError.badRequest(`"${line.title}" just went out of stock`, 'OUT_OF_STOCK');
        }
        // Take the same units out of the warehouses holding them, so the
        // location rows keep matching the variant total we just decremented.
        await allocateForDispatch(tx, {
          variantId: line.variantId,
          quantity: line.quantity,
          reference: orderNumber,
        });
      }
      // Reserve the credits (conditional — guards a concurrent double-spend).
      if (creditsUsed > 0) {
        const spent = await tx.user.updateMany({
          where: { id: userId, creditsBalance: { gte: creditsUsed } },
          data: { creditsBalance: { decrement: creditsUsed } },
        });
        if (spent.count === 0) {
          throw ApiError.badRequest('Your credits balance changed — please retry', 'CREDITS_CHANGED');
        }
      }
      // Reserve one redemption of the coupon (released again if payment fails).
      // Updating against the count we just read keeps a limited coupon from
      // being over-redeemed by two concurrent checkouts.
      if (couponCode && couponDiscountPaise > 0) {
        const coupon = await tx.coupon.findUnique({ where: { code: couponCode } });
        const exhausted =
          !coupon ||
          !coupon.isActive ||
          (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit);
        if (exhausted) {
          throw ApiError.badRequest('That coupon is no longer available', 'COUPON_INVALID');
        }
        const claimed = await tx.coupon.updateMany({
          where: { id: coupon.id, usedCount: coupon.usedCount },
          data: { usedCount: { increment: 1 } },
        });
        if (claimed.count === 0) {
          throw ApiError.badRequest('That coupon was just redeemed — please retry', 'COUPON_INVALID');
        }
      }
      const created = await tx.order.create({
        data: {
          orderNumber,
          userId,
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
          discountPaise,
          creditsUsed,
          couponCode,
          couponDiscountPaise,
          totalPaise,
          deliveryMethod,
          etaFrom: eta.from,
          etaTo: eta.to,
          isGift: isGift ?? false,
          giftMessage: isGift ? (giftMessage ?? null) : null,
          paymentMethod,
          billName: billing.name,
          billLine1: billing.line1,
          billLine2: billing.line2,
          billCity: billing.city,
          billState: billing.state,
          billPincode: billing.pincode,
          items: {
            // pricePaise is what the shopper actually pays per unit — a seller
            // promotion is already taken off it, so payouts, invoices and
            // refunds all read the same number.
            create: orderLines.map((line) => ({
              productId: line.productId,
              variantId: line.variantId,
              sellerId: sellerByVariant.get(line.variantId)!,
              title: line.title,
              size: line.size,
              color: line.color,
              pricePaise: line.pricePaise - Math.floor(line.promoDiscountPaise / line.quantity),
              quantity: line.quantity,
              status: 'PLACED',
              promotionId: line.promotion?.id ?? null,
              promoDiscountPaise: line.promoDiscountPaise,
            })),
          },
        },
      });
      if (creditsUsed > 0) {
        await tx.creditLedger.create({
          data: { userId, delta: -creditsUsed, reason: 'REDEEM_CHECKOUT', orderId: created.id },
        });
      }
      // Promotion usage trail — powers the seller's redemption and ROI panels.
      await recordRedemptions(tx as unknown as typeof prisma, {
        orderId: created.id,
        userId,
        lines: orderLines.map((line) => ({
          promotionId: line.promotion?.id ?? null,
          promoDiscountPaise: line.promoDiscountPaise,
          grossPaise: line.pricePaise * line.quantity,
        })),
      });
      return created;
    });

    if (paymentMethod === 'COD') {
      // Nothing to collect now — the order is confirmed and the courier
      // collects on delivery, so the payment row stays CREATED.
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

      const codBody: CheckoutResult = {
        orderId: order.id,
        orderNumber,
        amountPaise: totalPaise,
        method: paymentMethod,
        requiresPayment: false,
        payment: { provider: 'cod', providerOrderId: `cod_${order.orderNumber}` },
      };
      res.json({ success: true, data: codBody });
      return;
    }

    // Gateway order (outside the DB transaction; on failure the order stays
    // PLACED/unpaid and can be cancelled or retried).
    const providerOrderId = await paymentProvider.createOrder(totalPaise, orderNumber);
    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: paymentProvider.name,
        providerOrderId,
        amountPaise: totalPaise,
        status: 'CREATED',
      },
    });

    const body: CheckoutResult = {
      orderId: order.id,
      orderNumber,
      amountPaise: totalPaise,
      method: paymentMethod,
      requiresPayment: true,
      payment: {
        provider: paymentProvider.name,
        providerOrderId,
        keyId: paymentProvider.publicKeyId,
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// My orders
// ---------------------------------------------------------------------------

const orderListQuery = z.object({
  status: z.enum(ORDER_FILTERS).default('ALL'),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** Which order statuses each chip covers. */
const FILTER_STATUSES: Record<OrderFilter, OrderStatus[] | null> = {
  ALL: null,
  PROCESSING: ['PLACED', 'CONFIRMED', 'PACKED'],
  SHIPPED: ['SHIPPED'],
  DELIVERED: ['DELIVERED'],
  CANCELLED: ['CANCELLED'],
  RETURNED: ['RETURN_REQUESTED', 'RETURNED'],
};

ordersRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const query = orderListQuery.parse(req.query);

    const statuses = FILTER_STATUSES[query.status];
    const search = query.q
      ? {
          OR: [
            { orderNumber: { contains: query.q, mode: 'insensitive' as const } },
            { items: { some: { title: { contains: query.q, mode: 'insensitive' as const } } } },
          ],
        }
      : {};
    const where = {
      userId,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...search,
    };

    const [orders, total, allOrders] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          payment: { select: { provider: true } },
          _count: { select: { items: true } },
          items: {
            include: {
              product: {
                select: {
                  status: true,
                  images: { orderBy: { sortOrder: 'asc' }, take: 1 },
                },
              },
              variant: { select: { stock: true } },
            },
          },
        },
      }),
      prisma.order.count({ where }),
      // Counts + lifetime savings are computed over everything, not the page.
      prisma.order.findMany({
        where: { userId },
        select: { status: true, discountPaise: true, subtotalPaise: true },
      }),
    ]);

    const counts = Object.fromEntries(
      ORDER_FILTERS.map((f) => {
        const list = FILTER_STATUSES[f];
        return [
          f,
          list === null
            ? allOrders.length
            : allOrders.filter((o) => list.includes(o.status)).length,
        ];
      }),
    ) as Record<OrderFilter, number>;

    const rows: OrderListRow[] = orders.map((o) => {
      const images = o.items
        .map((i) => i.product.images[0]?.url)
        .filter((url): url is string => !!url);
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        totalPaise: o.totalPaise,
        itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
        previewImageUrl: images[0] ?? null,
        previewImages: images.slice(0, 4),
        productCount: o._count.items,
        paymentProvider: o.payment?.provider ?? null,
        deliveredAt:
          o.status === 'DELIVERED'
            ? (o.items
                .map((i) => i.deliveredAt)
                .filter((d): d is Date => d !== null)
                .sort((a, b) => b.getTime() - a.getTime())[0]
                ?.toISOString() ?? null)
            : null,
        etaFrom: o.etaFrom?.toISOString() ?? null,
        etaTo: o.etaTo?.toISOString() ?? null,
        canBuyAgain: o.items.every((i) => i.product.status === 'APPROVED' && i.variant.stock > 0),
        createdAt: o.createdAt.toISOString(),
      };
    });

    const body: OrderListResponse = {
      items: rows,
      total,
      summary: {
        counts,
        totalSavedPaise: allOrders.reduce((sum, o) => sum + o.discountPaise, 0),
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/** Re-add every item of a past order to the cart. */
ordersRouter.post('/:id/buy-again', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          include: {
            variant: { include: { product: { select: { status: true } } } },
          },
        },
      },
    });
    if (!order || order.userId !== userId) throw ApiError.notFound('Order not found');

    const cart = await prisma.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    let moved = 0;
    const skipped: string[] = [];
    for (const item of order.items) {
      const sellable =
        item.variant.product.status === 'APPROVED' && item.variant.stock >= item.quantity;
      if (!sellable) {
        skipped.push(item.title);
        continue;
      }
      const existing = await prisma.cartItem.findUnique({
        where: { cartId_variantId: { cartId: cart.id, variantId: item.variantId } },
      });
      await prisma.cartItem.upsert({
        where: { cartId_variantId: { cartId: cart.id, variantId: item.variantId } },
        update: {
          quantity: Math.min((existing?.quantity ?? 0) + item.quantity, 10),
          selected: true,
        },
        create: { cartId: cart.id, variantId: item.variantId, quantity: item.quantity },
      });
      moved += 1;
    }
    if (moved === 0) {
      throw ApiError.badRequest('Nothing from this order is available right now', 'NOTHING_TO_ADD');
    }
    res.json({ success: true, data: { moved, skipped } });
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/:id', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        payment: true,
        items: {
          include: {
            product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
            variant: { include: { product: { select: { status: true } } } },
            seller: { select: { shopName: true, returnWindowDays: true } },
            return: { include: { refund: true } },
          },
        },
      },
    });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');

    // Products this shopper has already reviewed — so "Write a review" only
    // shows where it can actually be used.
    const reviews = await prisma.review.findMany({
      where: {
        userId: req.auth!.userId,
        productId: { in: order.items.map((i) => i.productId) },
      },
      select: { productId: true },
    });
    const reviewedProductIds = new Set(reviews.map((r) => r.productId));

    const earnedRows = await prisma.creditLedger.findMany({
      where: { orderId: order.id, delta: { gt: 0 }, reason: 'EARN_PURCHASE' },
      select: { delta: true },
    });
    const earnedCredits = earnedRows.reduce((sum, r) => sum + r.delta, 0);

    // Order-level milestones = the last item to reach each stage.
    const shippedStamps = order.items.map((i) => i.shippedAt).filter((d): d is Date => d !== null);
    const deliveredStamps = order.items
      .map((i) => i.deliveredAt)
      .filter((d): d is Date => d !== null);
    const shippedAt =
      shippedStamps.length === order.items.length && shippedStamps.length > 0
        ? new Date(Math.max(...shippedStamps.map((d) => d.getTime())))
        : null;
    const deliveredAt =
      deliveredStamps.length === order.items.length && deliveredStamps.length > 0
        ? new Date(Math.max(...deliveredStamps.map((d) => d.getTime())))
        : null;

    // Packed items haven't left the warehouse yet, so they stay cancellable.
    const cancellable = ['PLACED', 'CONFIRMED', 'PACKED'];
    // Each seller may promise a longer return window than the platform's.
    const windowMsFor = (days: number | null | undefined) =>
      (days ?? env.RETURN_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
    const body: OrderDetailView = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      shipTo: {
        name: order.shipName,
        phone: order.shipPhone,
        line1: order.shipLine1,
        line2: order.shipLine2,
        city: order.shipCity,
        state: order.shipState,
        pincode: order.shipPincode,
      },
      discountPaise: order.discountPaise,
      creditsUsed: order.creditsUsed,
      couponCode: order.couponCode,
      couponDiscountPaise: order.couponDiscountPaise,
      deliveryMethod: order.deliveryMethod,
      paymentMethod: order.paymentMethod as CheckoutResult['method'],
      etaFrom: order.etaFrom?.toISOString() ?? null,
      etaTo: order.etaTo?.toISOString() ?? null,
      isGift: order.isGift,
      giftMessage: order.giftMessage,
      earnedCredits,
      timeline: {
        placedAt: order.createdAt.toISOString(),
        confirmedAt:
          order.payment?.status === 'PAID' ? order.payment.updatedAt.toISOString() : null,
        // The order is "shipped"/"delivered" once every item has moved on.
        shippedAt: shippedAt?.toISOString() ?? null,
        deliveredAt: deliveredAt?.toISOString() ?? null,
      },
      items: order.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productSlug: i.product.slug,
        title: i.title,
        size: i.size,
        color: i.color,
        quantity: i.quantity,
        pricePaise: i.pricePaise,
        status: i.status,
        imageUrl: i.product.images[0]?.url ?? null,
        shopName: i.seller.shopName,
        returnStatus: i.return?.status ?? null,
        returnInfo: i.return
          ? {
              id: i.return.id,
              status: i.return.status,
              reason: i.return.reasonCategory,
              details: i.return.reason || null,
              photos: i.return.photos,
              rejectionReason: i.return.rejectionReason,
              requestedAt: i.return.createdAt.toISOString(),
              approvedAt: i.return.approvedAt?.toISOString() ?? null,
              rejectedAt: i.return.rejectedAt?.toISOString() ?? null,
              receivedAt: i.return.receivedAt?.toISOString() ?? null,
              refund: i.return.refund
                ? {
                    status: i.return.refund.status,
                    amountPaise: i.return.refund.amountPaise,
                    processedAt: i.return.refund.processedAt?.toISOString() ?? null,
                  }
                : null,
            }
          : null,
        canReturn:
          i.status === 'DELIVERED' &&
          !i.return &&
          !!i.deliveredAt &&
          Date.now() - i.deliveredAt.getTime() <= windowMsFor(i.seller.returnWindowDays),
        courierName: i.courierName,
        awbNumber: i.awbNumber,
        trackingUrl: i.trackingUrl,
        shippedAt: i.shippedAt?.toISOString() ?? null,
        deliveredAt: i.deliveredAt?.toISOString() ?? null,
        canReview: i.status === 'DELIVERED' && !reviewedProductIds.has(i.productId),
        variantId: i.variant.stock >= 0 && i.variant.product.status === 'APPROVED'
          ? i.variantId
          : null,
      })),
      subtotalPaise: order.subtotalPaise,
      shippingPaise: order.shippingPaise,
      totalPaise: order.totalPaise,
      payment: order.payment
        ? {
            provider: order.payment.provider,
            status: order.payment.status,
            transactionId: order.payment.providerPaymentId ?? order.payment.providerOrderId,
            paidAt:
              order.payment.status === 'PAID' ? order.payment.updatedAt.toISOString() : null,
          }
        : null,
      awaitingPayment: order.payment?.status === 'CREATED' && order.status === 'PLACED',
      canCancel:
        order.status !== 'CANCELLED' && order.items.every((i) => cancellable.includes(i.status)),
      returnWindowDays: env.RETURN_WINDOW_DAYS,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Cancel an order while nothing has shipped. Restores stock.
ordersRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true, payment: true },
    });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');
    if (order.status === 'CANCELLED') throw ApiError.badRequest('Order is already cancelled');
    if (!order.items.every((i) => ['PLACED', 'CONFIRMED', 'PACKED'].includes(i.status))) {
      throw ApiError.badRequest('Order cannot be cancelled after items have shipped');
    }

    await prisma.$transaction([
      prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } }),
      prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { status: 'CANCELLED' } }),
      ...order.items.map((item) =>
        prisma.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { increment: item.quantity } },
        }),
      ),
      // A cancelled order gives its coupon redemption back to the pool.
      ...(order.couponCode && order.couponDiscountPaise > 0
        ? [
            prisma.coupon.updateMany({
              where: { code: order.couponCode, usedCount: { gt: 0 } },
              data: { usedCount: { decrement: 1 } },
            }),
          ]
        : []),
      // Redeemed credits come back on cancellation.
      ...(order.creditsUsed > 0
        ? [
            prisma.user.update({
              where: { id: order.userId },
              data: { creditsBalance: { increment: order.creditsUsed } },
            }),
            prisma.creditLedger.create({
              data: {
                userId: order.userId,
                delta: order.creditsUsed,
                reason: 'REFUND_CREDITS',
                orderId: order.id,
                expiresAt: creditExpiryFrom(),
              },
            }),
          ]
        : []),
      // Paid orders are marked for refund (actual gateway refund is a later phase).
      ...(order.payment && order.payment.status === 'PAID'
        ? [
            prisma.payment.update({
              where: { id: order.payment.id },
              data: { status: 'REFUNDED' },
            }),
          ]
        : []),
    ]);

    // The variant totals are back up; put the units back on the shelf they
    // shipped from and leave a ledger entry explaining why they reappeared.
    await prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        await returnStock(tx, {
          variantId: item.variantId,
          quantity: item.quantity,
          reason: 'Order cancelled by customer',
          reference: order.orderNumber,
          actorId: order.userId,
        });
      }
    });

    res.json({ success: true, data: { cancelled: true } });
  } catch (err) {
    next(err);
  }
});

// Request a return for a delivered item (inside the return window).
ordersRouter.post('/items/:itemId/return', async (req, res, next) => {
  try {
    const input = returnRequestSchema.parse(req.body);
    const item = await prisma.orderItem.findUnique({
      where: { id: req.params.itemId },
      include: {
        order: { select: { userId: true, orderNumber: true } },
        seller: { select: { userId: true, returnWindowDays: true } },
        return: true,
      },
    });
    if (!item || item.order.userId !== req.auth!.userId) throw ApiError.notFound('Item not found');
    if (item.status !== 'DELIVERED') {
      throw ApiError.badRequest('Only delivered items can be returned');
    }
    if (item.return) throw ApiError.badRequest('Return already requested for this item');

    // Return window enforced server-side (UI hides the button, this is the law).
    // The seller may allow longer than the platform default, never shorter.
    const policy = await getSettings();
    const windowDays = item.seller.returnWindowDays ?? policy.returnWindowDays;
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    if (!item.deliveredAt || Date.now() - item.deliveredAt.getTime() > windowMs) {
      throw ApiError.badRequest(
        `Returns are accepted within ${windowDays} days of delivery`,
        'RETURN_WINDOW_CLOSED',
      );
    }

    const rmaNumber = await nextRmaNumber();
    await prisma.$transaction([
      prisma.return.create({
        data: {
          rmaNumber,
          orderItemId: item.id,
          userId: req.auth!.userId,
          reasonCategory: input.reason,
          reason: input.details ?? '',
          photos: input.photos ?? [],
        },
      }),
      prisma.orderItem.update({
        where: { id: item.id },
        data: { status: 'RETURN_REQUESTED' },
      }),
      // Tell the seller a return needs their action.
      prisma.notification.create({
        data: {
          userId: item.seller.userId,
          type: 'RETURN_REQUESTED',
          title: 'Return requested ↩',
          body: `A customer requested a return for "${item.title}" (${item.order.orderNumber}). Review it in your seller panel → Returns.`,
        },
      }),
    ]);
    res.json({ success: true, data: { requested: true } });
  } catch (err) {
    next(err);
  }
});
