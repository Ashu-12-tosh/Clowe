import { Router } from 'express';
import { z } from 'zod';
import {
  NOTIFICATION_CATEGORIES,
  notificationCategory,
  type NotificationCategory,
  type NotificationList,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const listQuery = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  /** Optional createdAt window for the "received in" filter (ISO dates). */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

// My notifications: filtered page + the counts the summary card shows.
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const query = listQuery.parse(req.query);

    // Category lives in code (derived from `type`), so the filter and the
    // per-category counts are both computed over the full list.
    const [all, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    const withCategory = all.map((n) => ({ ...n, category: notificationCategory(n.type) }));
    // Window + category narrow the page; the summary stays over everything.
    const filtered = withCategory.filter(
      (n) =>
        (!query.category || n.category === query.category) &&
        (!query.from || n.createdAt >= query.from) &&
        (!query.to || n.createdAt < query.to),
    );

    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgo = now - 7 * 24 * 3600 * 1000;

    const byCategory = Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((c) => [c, withCategory.filter((n) => n.category === c).length]),
    ) as Record<NotificationCategory, number>;

    const page = filtered.slice((query.page - 1) * query.limit, query.page * query.limit);
    const body: NotificationList = {
      items: page.map((n) => ({
        id: n.id,
        type: n.type,
        category: n.category,
        title: n.title,
        body: n.body,
        linkHref: n.linkHref,
        imageUrl: n.imageUrl,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
      total: filtered.length,
      summary: {
        total: withCategory.length,
        unread: unreadCount,
        today: withCategory.filter((n) => n.createdAt >= startOfToday).length,
        thisWeek: withCategory.filter((n) => n.createdAt.getTime() >= weekAgo).length,
        byCategory,
        firstAt: all.length > 0 ? all[all.length - 1].createdAt.toISOString() : null,
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// Mark everything read.
notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    const { count } = await prisma.notification.updateMany({
      where: { userId: req.auth!.userId, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ success: true, data: { read: count } });
  } catch (err) {
    next(err);
  }
});

// Mark / unmark one row.
notificationsRouter.post('/:id/read', async (req, res, next) => {
  try {
    const read = (req.body as { read?: boolean }).read !== false;
    const { count } = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.auth!.userId },
      data: { readAt: read ? new Date() : null },
    });
    if (count === 0) throw ApiError.notFound('Notification not found');
    res.json({ success: true, data: { id: req.params.id, read } });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { count } = await prisma.notification.deleteMany({
      where: { id: req.params.id, userId: req.auth!.userId },
    });
    if (count === 0) throw ApiError.notFound('Notification not found');
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// Clear everything that has already been read.
notificationsRouter.delete('/', async (req, res, next) => {
  try {
    const { count } = await prisma.notification.deleteMany({
      where: { userId: req.auth!.userId, readAt: { not: null } },
    });
    res.json({ success: true, data: { deleted: count } });
  } catch (err) {
    next(err);
  }
});
