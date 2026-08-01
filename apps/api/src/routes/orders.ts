import { Router } from 'express';
import {
  checkoutSchema,
  creditsToPaise,
  CREDIT_VALUE_PAISE,
  returnRequestSchema,
  type CheckoutResult,
  type OrderDetailView,
  type OrderListRow,
} from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { paymentProvider } from '../services/payments';
import { buildCartView, shippingFor } from './cart';
import { generateOrderNumber } from '../services/orderService';

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
    const { addressId, useCredits } = checkoutSchema.parse(req.body);
    const userId = req.auth!.userId;

    const address = await prisma.address.findUnique({ where: { id: addressId } });
    if (!address || address.userId !== userId) throw ApiError.badRequest('Address not found');

    const cart = await buildCartView(userId);
    if (cart.lines.length === 0) throw ApiError.badRequest('Your cart is empty', 'CART_EMPTY');

    // Re-check stock at checkout time.
    for (const line of cart.lines) {
      if (line.stock < line.quantity) {
        throw ApiError.badRequest(
          `"${line.title}" (${line.color}/${line.size}) has only ${line.stock} left`,
          'OUT_OF_STOCK',
        );
      }
    }

    // Variant → seller mapping for order items.
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: cart.lines.map((l) => l.variantId) } },
      include: { product: { select: { sellerId: true } } },
    });
    const sellerByVariant = new Map(variants.map((v) => [v.id, v.product.sellerId]));

    const orderNumber = await generateOrderNumber();
    const subtotalPaise = cart.subtotalPaise;
    const shippingPaise = shippingFor(subtotalPaise);

    // Optional shopping-credits discount (user's choice at the payment step).
    // Redeemable up to the order value minus ₹1 (gateways need a payable amount).
    let creditsUsed = 0;
    if (useCredits) {
      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { creditsBalance: true },
      });
      const maxDiscountPaise = Math.max(0, subtotalPaise + shippingPaise - 100);
      creditsUsed = Math.min(me?.creditsBalance ?? 0, Math.floor(maxDiscountPaise / CREDIT_VALUE_PAISE));
    }
    const discountPaise = creditsToPaise(creditsUsed);
    const totalPaise = subtotalPaise + shippingPaise - discountPaise;

    // Create the order and reserve stock atomically. Conditional decrements
    // guard against a concurrent checkout taking the last unit.
    const order = await prisma.$transaction(async (tx) => {
      for (const line of cart.lines) {
        const updated = await tx.productVariant.updateMany({
          where: { id: line.variantId, stock: { gte: line.quantity } },
          data: { stock: { decrement: line.quantity } },
        });
        if (updated.count === 0) {
          throw ApiError.badRequest(`"${line.title}" just went out of stock`, 'OUT_OF_STOCK');
        }
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
          totalPaise,
          items: {
            create: cart.lines.map((line) => ({
              productId: line.productId,
              variantId: line.variantId,
              sellerId: sellerByVariant.get(line.variantId)!,
              title: line.title,
              size: line.size,
              color: line.color,
              pricePaise: line.pricePaise,
              quantity: line.quantity,
              status: 'PLACED',
            })),
          },
        },
      });
      if (creditsUsed > 0) {
        await tx.creditLedger.create({
          data: { userId, delta: -creditsUsed, reason: 'REDEEM_CHECKOUT', orderId: created.id },
        });
      }
      return created;
    });

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

ordersRouter.get('/', async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { userId: req.auth!.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        _count: { select: { items: true } },
        items: {
          take: 1,
          include: {
            product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
          },
        },
      },
    });
    const rows: OrderListRow[] = orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      totalPaise: o.totalPaise,
      itemCount: o._count.items,
      previewImageUrl: o.items[0]?.product.images[0]?.url ?? null,
      createdAt: o.createdAt.toISOString(),
    }));
    res.json({ success: true, data: rows });
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
            seller: { select: { shopName: true } },
            return: { include: { refund: true } },
          },
        },
      },
    });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');

    const cancellable = ['PLACED', 'CONFIRMED'];
    const windowMs = env.RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
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
      items: order.items.map((i) => ({
        id: i.id,
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
          Date.now() - i.deliveredAt.getTime() <= windowMs,
        courierName: i.courierName,
        awbNumber: i.awbNumber,
      })),
      subtotalPaise: order.subtotalPaise,
      shippingPaise: order.shippingPaise,
      totalPaise: order.totalPaise,
      payment: order.payment
        ? { provider: order.payment.provider, status: order.payment.status }
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
    if (!order.items.every((i) => ['PLACED', 'CONFIRMED'].includes(i.status))) {
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
        seller: { select: { userId: true } },
        return: true,
      },
    });
    if (!item || item.order.userId !== req.auth!.userId) throw ApiError.notFound('Item not found');
    if (item.status !== 'DELIVERED') {
      throw ApiError.badRequest('Only delivered items can be returned');
    }
    if (item.return) throw ApiError.badRequest('Return already requested for this item');

    // Return window enforced server-side (UI hides the button, this is the law).
    const windowMs = env.RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (!item.deliveredAt || Date.now() - item.deliveredAt.getTime() > windowMs) {
      throw ApiError.badRequest(
        `Returns are accepted within ${env.RETURN_WINDOW_DAYS} days of delivery`,
        'RETURN_WINDOW_CLOSED',
      );
    }

    await prisma.$transaction([
      prisma.return.create({
        data: {
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
