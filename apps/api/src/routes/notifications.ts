import { Router } from 'express';
import type { NotificationList } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

// My notifications, newest first, with unread count.
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const [rows, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.auth!.userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.notification.count({ where: { userId: req.auth!.userId, readAt: null } }),
    ]);
    const body: NotificationList = {
      items: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Mark everything read.
notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.auth!.userId, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ success: true, data: { read: true } });
  } catch (err) {
    next(err);
  }
});
