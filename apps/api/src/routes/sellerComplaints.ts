import { Router } from 'express';
import { sellerComplaintReplySchema, type SellerComplaintRow } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { sellerReplyToComplaint } from '../services/complaintService';
import { ApiError } from '../utils/ApiError';
import { blockSuspendedWrites, requireSeller } from './seller';

// ---------------------------------------------------------------------------
// Customer complaints about a seller's own products, routed to them by
// support (Customer Support and Grievance Policy 2.4): the seller answers
// within 24 hours, and the buyer sees the reply in their ticket. Internal
// desk notes never reach the seller.
// ---------------------------------------------------------------------------

export const sellerComplaintsRouter = Router();
sellerComplaintsRouter.use(requireAuth, requireSeller);

sellerComplaintsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.complaint.findMany({
      where: { sellerId: req.seller!.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        order: { select: { orderNumber: true } },
        messages: { where: { isInternal: false }, orderBy: { createdAt: 'asc' }, select: { authorRole: true, body: true, createdAt: true } },
      },
    });
    const now = Date.now();
    const body: SellerComplaintRow[] = rows.map((c) => ({
      id: c.id,
      reference: c.complaintId,
      orderNumber: c.order?.orderNumber ?? null,
      subject: c.subject ?? 'Product complaint',
      description: c.description,
      status: c.status,
      dueAt: c.sellerDueAt?.toISOString() ?? null,
      respondedAt: c.sellerRespondedAt?.toISOString() ?? null,
      overdue: !c.sellerRespondedAt && !!c.sellerDueAt && c.sellerDueAt.getTime() < now,
      createdAt: c.createdAt.toISOString(),
      messages: c.messages.map((m) => ({ authorRole: m.authorRole, body: m.body, createdAt: m.createdAt.toISOString() })),
    }));
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

sellerComplaintsRouter.post('/:id/reply', blockSuspendedWrites, async (req, res, next) => {
  try {
    const { body } = sellerComplaintReplySchema.parse(req.body);
    if (!req.params.id) throw ApiError.notFound('Complaint not found');
    await sellerReplyToComplaint({ complaintId: req.params.id, sellerId: req.seller!.id, authorId: req.auth!.userId, body });
    res.json({ success: true, data: { replied: true } });
  } catch (err) {
    next(err);
  }
});
