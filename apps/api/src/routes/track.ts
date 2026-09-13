import { Router } from 'express';
import { trackOrderSchema, type TrackOrderView } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';

// Public order tracking: order number + the phone the order ships to.
export const trackRouter = Router();

trackRouter.get('/', async (req, res, next) => {
  try {
    const input = trackOrderSchema.parse({
      orderNumber: req.query.orderNumber,
      phone: req.query.phone,
    });
    const order = await prisma.order.findUnique({
      where: { orderNumber: input.orderNumber.toUpperCase() },
      include: {
        payment: true,
        user: { select: { phone: true } },
        items: {
          include: {
            product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } },
          },
        },
      },
    });
    // Phone must match the shipping contact or the account that ordered.
    if (!order || (order.shipPhone !== input.phone && order.user.phone !== input.phone)) {
      throw ApiError.notFound(
        'No order found for this order number and phone combination',
        'ORDER_NOT_FOUND',
      );
    }

    const body: TrackOrderView = {
      orderNumber: order.orderNumber,
      status: order.status,
      placedAt: order.createdAt.toISOString(),
      paid: order.payment?.status === 'PAID',
      shipCity: order.shipCity,
      shipState: order.shipState,
      shipPincode: order.shipPincode,
      items: order.items.map((i) => ({
        title: i.title,
        imageUrl: i.product.images[0]?.url ?? null,
        quantity: i.quantity,
        size: i.size,
        color: i.color,
        variantLabel: i.variantLabel,
        status: i.status,
        shippedAt: i.shippedAt?.toISOString() ?? null,
        deliveredAt: i.deliveredAt?.toISOString() ?? null,
        courierName: i.courierName,
        awbNumber: i.awbNumber,
        trackingUrl: i.trackingUrl,
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
