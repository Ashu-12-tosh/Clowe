import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { complaintCreateSchema, type ComplaintRow } from '@clowe/shared';
import {
  SLA_RESPONSE_HOURS,
  customerRatingSchema,
  customerReplySchema,
  type DeskPriority,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

export const complaintsRouter = Router();
complaintsRouter.use(requireAuth);

/** Human-readable unique complaint id, e.g. CMP-2026-48213. */
async function generateComplaintId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `CMP-${new Date().getFullYear()}-${randomInt(0, 100000)
      .toString()
      .padStart(5, '0')}`;
    const exists = await prisma.complaint.findUnique({ where: { complaintId: candidate } });
    if (!exists) return candidate;
  }
  throw new Error('Could not generate a unique complaint id');
}

// Raise a complaint (used by the support chat bot).
complaintsRouter.post('/', async (req, res, next) => {
  try {
    const input = complaintCreateSchema.parse(req.body);

    // If an order is referenced it must belong to the caller.
    let orderId: string | null = null;
    if (input.orderId) {
      const order = await prisma.order.findUnique({ where: { id: input.orderId } });
      if (!order || order.userId !== req.auth!.userId) {
        throw ApiError.badRequest('Order not found', 'ORDER_NOT_FOUND');
      }
      orderId = order.id;
    }

    const complaintId = await generateComplaintId();
    // Payment and delivery problems cost the shopper money or time, so they
    // start higher up the queue with a tighter response target.
    const priority: DeskPriority =
      input.category === 'PAYMENT' ? 'HIGH' : input.category === 'DELIVERY' ? 'HIGH' : 'MEDIUM';
    const now = new Date();

    const complaint = await prisma.complaint.create({
      data: {
        complaintId,
        userId: req.auth!.userId,
        orderId,
        category: input.category,
        subject: input.description.split('\n')[0]!.slice(0, 90),
        description: input.description,
        priority,
        channel: 'CHAT',
        slaDueAt: new Date(now.getTime() + SLA_RESPONSE_HOURS[priority] * 3600000),
        lastMessageAt: now,
        // The opening description is the first turn of the conversation.
        messages: {
          create: {
            authorId: req.auth!.userId,
            authorRole: 'CUSTOMER',
            body: input.description,
          },
        },
      },
      include: { order: { select: { orderNumber: true } } },
    });

    await prisma.notification.create({
      data: {
        userId: req.auth!.userId,
        type: 'COMPLAINT_REGISTERED',
        title: 'Complaint registered 📢',
        body: `Your complaint ${complaintId} has been registered. Our team will get back to you.`,
      },
    });

    const body: ComplaintRow = {
      id: complaint.id,
      complaintId: complaint.complaintId,
      category: complaint.category as ComplaintRow['category'],
      description: complaint.description,
      status: complaint.status,
      orderNumber: complaint.order?.orderNumber ?? null,
      createdAt: complaint.createdAt.toISOString(),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// My complaints (account page "My complaints" list).
complaintsRouter.get('/me', async (req, res, next) => {
  try {
    const rows = await prisma.complaint.findMany({
      where: { userId: req.auth!.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { order: { select: { orderNumber: true } } },
    });
    const body: ComplaintRow[] = rows.map((c) => ({
      id: c.id,
      complaintId: c.complaintId,
      category: c.category as ComplaintRow['category'],
      description: c.description,
      status: c.status,
      orderNumber: c.order?.orderNumber ?? null,
      createdAt: c.createdAt.toISOString(),
    }));
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The shopper's own conversation
// ---------------------------------------------------------------------------

/** Full thread for one of my complaints (internal notes are never included). */
complaintsRouter.get('/:id', async (req, res, next) => {
  try {
    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, userId: req.auth!.userId },
      include: {
        order: { select: { orderNumber: true } },
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { name: true } } },
        },
      },
    });
    if (!complaint) throw ApiError.notFound('Complaint not found');

    res.json({
      success: true,
      data: {
        id: complaint.id,
        complaintId: complaint.complaintId,
        category: complaint.category,
        subject: complaint.subject ?? complaint.category,
        description: complaint.description,
        status: complaint.status,
        orderNumber: complaint.order?.orderNumber ?? null,
        rating: complaint.rating,
        createdAt: complaint.createdAt.toISOString(),
        messages: complaint.messages.map((m) => ({
          id: m.id,
          authorRole: m.authorRole,
          authorName: m.authorRole === 'AGENT' ? (m.author?.name ?? 'Clowe support') : 'You',
          body: m.body,
          createdAt: m.createdAt.toISOString(),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

complaintsRouter.post('/:id/reply', async (req, res, next) => {
  try {
    const input = customerReplySchema.parse(req.body);
    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, userId: req.auth!.userId },
    });
    if (!complaint) throw ApiError.notFound('Complaint not found');
    if (complaint.status === 'CLOSED') {
      throw ApiError.badRequest('This complaint is closed — please raise a new one', 'CLOSED');
    }

    await prisma.complaint.update({
      where: { id: complaint.id },
      data: {
        lastMessageAt: new Date(),
        // Answering a resolved ticket reopens it for the desk.
        status:
          complaint.status === 'RESOLVED' || complaint.status === 'PENDING_CUSTOMER'
            ? 'OPEN'
            : complaint.status,
        ...(complaint.status === 'RESOLVED' ? { resolvedAt: null } : {}),
        messages: {
          create: {
            authorId: req.auth!.userId,
            authorRole: 'CUSTOMER',
            body: input.body,
          },
        },
      },
    });
    res.json({ success: true, data: { id: complaint.id } });
  } catch (err) {
    next(err);
  }
});

/** Rate the support received — only once the desk has settled it. */
complaintsRouter.post('/:id/rating', async (req, res, next) => {
  try {
    const input = customerRatingSchema.parse(req.body);
    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, userId: req.auth!.userId },
    });
    if (!complaint) throw ApiError.notFound('Complaint not found');
    if (complaint.status !== 'RESOLVED' && complaint.status !== 'CLOSED') {
      throw ApiError.badRequest('You can rate support once the complaint is resolved', 'NOT_SETTLED');
    }

    await prisma.complaint.update({
      where: { id: complaint.id },
      data: { rating: input.rating, ratingComment: input.comment?.trim() || null },
    });
    res.json({ success: true, data: { id: complaint.id, rating: input.rating } });
  } catch (err) {
    next(err);
  }
});
