import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { complaintCreateSchema, type ComplaintRow } from '@clowe/shared';
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
    const complaint = await prisma.complaint.create({
      data: {
        complaintId,
        userId: req.auth!.userId,
        orderId,
        category: input.category,
        description: input.description,
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
