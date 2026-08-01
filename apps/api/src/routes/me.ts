import { Router } from 'express';
import type { MyCounts } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';

export const meRouter = Router();
meRouter.use(requireAuth);

// Light badge counts for the header (cart / wishlist / unread notifications).
meRouter.get('/counts', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const [cartAgg, wishlist, notifications] = await Promise.all([
      prisma.cartItem.aggregate({
        where: { cart: { userId }, variant: { product: { status: 'APPROVED' } } },
        _sum: { quantity: true },
      }),
      prisma.wishlist.count({ where: { userId, product: { status: 'APPROVED' } } }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    const body: MyCounts = {
      cart: cartAgg._sum.quantity ?? 0,
      wishlist,
      notifications,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
