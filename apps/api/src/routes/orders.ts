import { Router } from 'express';
import {
  checkoutSchema,
  returnRequestSchema,
  type CheckoutResult,
  type OrderDetailView,
  type OrderListRow,
} from '@clowe/shared';
import { prisma } from '../db';
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
    const { addressId } = checkoutSchema.parse(req.body);
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
    const totalPaise = subtotalPaise + shippingPaise;

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
      return tx.order.create({
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
            return: { select: { status: true } },
          },
        },
      },
    });
    if (!order || order.userId !== req.auth!.userId) throw ApiError.notFound('Order not found');

    const cancellable = ['PLACED', 'CONFIRMED'];
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

// Request a return for a delivered item.
ordersRouter.post('/items/:itemId/return', async (req, res, next) => {
  try {
    const { reason } = returnRequestSchema.parse(req.body);
    const item = await prisma.orderItem.findUnique({
      where: { id: req.params.itemId },
      include: { order: { select: { userId: true } }, return: true },
    });
    if (!item || item.order.userId !== req.auth!.userId) throw ApiError.notFound('Item not found');
    if (item.status !== 'DELIVERED') {
      throw ApiError.badRequest('Only delivered items can be returned');
    }
    if (item.return) throw ApiError.badRequest('Return already requested for this item');

    await prisma.$transaction([
      prisma.return.create({
        data: { orderItemId: item.id, userId: req.auth!.userId, reason },
      }),
      prisma.orderItem.update({
        where: { id: item.id },
        data: { status: 'RETURN_REQUESTED' },
      }),
    ]);
    res.json({ success: true, data: { requested: true } });
  } catch (err) {
    next(err);
  }
});
