import { Router } from 'express';
import { complaintCreateSchema, complaintEscalateSchema, type ComplaintRow, type SupportLevel } from '@clowe/shared';
import {
  customerRatingSchema,
  customerReplySchema,
  type DeskPriority,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { escalateComplaint, raiseComplaint } from '../services/complaintService';
import { ApiError } from '../utils/ApiError';

export const complaintsRouter = Router();
complaintsRouter.use(requireAuth);

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

    // Payment and delivery problems cost the shopper money or time, so they
    // start higher up the queue with a tighter response target.
    const priority: DeskPriority =
      input.category === 'PAYMENT' ? 'HIGH' : input.category === 'DELIVERY' ? 'HIGH' : 'MEDIUM';
    const complaint = await raiseComplaint({
      userId: req.auth!.userId,
      orderId,
      category: input.category,
      subject: input.description.split('\n')[0]!,
      description: input.description,
      priority,
      channel: 'CHAT',
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

// Not satisfied: up to the Nodal Officer, then the Grievance Officer (Grievance Policy 3.1).
complaintsRouter.post('/:id/escalate', async (req, res, next) => {
  try {
    const { reason } = complaintEscalateSchema.parse(req.body);
    const result = await escalateComplaint({ complaintId: req.params.id!, by: 'CUSTOMER', actorId: req.auth!.userId, reason });
    res.json({ success: true, data: result });
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
      level: c.level as SupportLevel,
      resolveDueAt: c.resolveDueAt?.toISOString() ?? null,
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
          authorName:
            m.authorRole === 'AGENT'
              ? (m.author?.name ?? 'Clowe support')
              : m.authorRole === 'SELLER'
                ? 'The seller'
                : m.authorRole === 'SYSTEM'
                  ? 'Clowe'
                  : 'You',
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
