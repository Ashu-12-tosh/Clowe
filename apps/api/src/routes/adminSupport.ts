import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  TICKET_CATEGORY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  ticketAdminUpdateSchema,
  ticketReplySchema,
  type SupportTicketDetail,
  type SupportTicketPage,
  type SupportTicketRow,
  type TicketCategory,
  type TicketPriorityValue,
  type TicketStatusValue,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

export const adminSupportRouter = Router();
adminSupportRouter.use(requireAuth, requireRole('ADMIN'));

const TICKET_INCLUDE = {
  seller: { select: { shopName: true, user: { select: { id: true } } } },
  messages: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { name: true } } },
  },
} satisfies Prisma.SupportTicketInclude;

type TicketRecord = Prisma.SupportTicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

function toRow(ticket: TicketRecord): SupportTicketRow & { shopName: string } {
  const last = ticket.messages[ticket.messages.length - 1];
  return {
    id: ticket.id,
    reference: ticket.reference,
    category: ticket.category as TicketCategory,
    categoryLabel: TICKET_CATEGORY_LABELS[ticket.category as TicketCategory] ?? ticket.category,
    subject: ticket.subject,
    status: ticket.status as TicketStatusValue,
    statusLabel: TICKET_STATUS_LABELS[ticket.status as TicketStatusValue],
    priority: ticket.priority as TicketPriorityValue,
    orderNumber: ticket.orderNumber,
    messageCount: ticket.messages.length,
    lastMessage: last ? last.body.slice(0, 140) : null,
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    firstResponseMinutes: ticket.firstReplyAt
      ? Math.round((ticket.firstReplyAt.getTime() - ticket.createdAt.getTime()) / 60000)
      : null,
    rating: ticket.rating,
    createdAt: ticket.createdAt.toISOString(),
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    shopName: ticket.seller.shopName,
  };
}

function toDetail(ticket: TicketRecord): SupportTicketDetail {
  return {
    ...toRow(ticket),
    messages: ticket.messages.map((m) => ({
      id: m.id,
      authorRole: m.authorRole as 'SELLER' | 'ADMIN',
      authorName: m.author.name,
      body: m.body,
      attachments: m.attachments,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

const listQuery = z.object({
  status: z.enum(['ALL', ...TICKET_STATUSES]).default('ALL'),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(20),
});

adminSupportRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const where: Prisma.SupportTicketWhereInput = {
      ...(query.status !== 'ALL' ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { subject: { contains: query.q, mode: 'insensitive' } },
              { reference: { contains: query.q.toUpperCase() } },
              { seller: { shopName: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [total, tickets] = await Promise.all([
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.findMany({
        where,
        // Oldest waiting first — the queue a human should work through.
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: TICKET_INCLUDE,
      }),
    ]);

    const body: SupportTicketPage = {
      rows: tickets.map(toRow),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

adminSupportRouter.get('/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');
    res.json({ success: true, data: toDetail(ticket) });
  } catch (err) {
    next(err);
  }
});

adminSupportRouter.post('/:id/reply', async (req, res, next) => {
  try {
    const input = ticketReplySchema.parse(req.body);
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: { seller: { select: { userId: true, shopName: true } } },
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');

    const now = new Date();
    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        lastMessageAt: now,
        // First staff reply stamps the response-time metric.
        firstReplyAt: ticket.firstReplyAt ?? now,
        status: ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status,
        messages: {
          create: {
            authorId: req.auth!.userId,
            authorRole: 'ADMIN',
            body: input.body,
            attachments: input.attachments,
          },
        },
      },
      include: TICKET_INCLUDE,
    });

    await prisma.notification.create({
      data: {
        userId: ticket.seller.userId,
        type: 'SUPPORT_REPLY',
        title: `Support replied on ${ticket.reference}`,
        body: input.body.slice(0, 160),
        linkHref: '/seller/support',
      },
    });

    res.json({ success: true, data: toDetail(updated) });
  } catch (err) {
    next(err);
  }
});

adminSupportRouter.patch('/:id', async (req, res, next) => {
  try {
    const input = ticketAdminUpdateSchema.parse(req.body);
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: { seller: { select: { userId: true } } },
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');

    const now = new Date();
    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.status === 'RESOLVED' ? { resolvedAt: ticket.resolvedAt ?? now } : {}),
        ...(input.status === 'CLOSED' ? { closedAt: now, resolvedAt: ticket.resolvedAt ?? now } : {}),
      },
      include: TICKET_INCLUDE,
    });

    if (input.status === 'RESOLVED') {
      await prisma.notification.create({
        data: {
          userId: ticket.seller.userId,
          type: 'SUPPORT_RESOLVED',
          title: `${ticket.reference} marked resolved`,
          body: 'If this is sorted, you can rate the support you received. Replying reopens the ticket.',
          linkHref: '/seller/support',
        },
      });
    }

    res.json({ success: true, data: toDetail(updated) });
  } catch (err) {
    next(err);
  }
});
