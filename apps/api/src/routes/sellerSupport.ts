import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  TICKET_CATEGORY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  ticketCreateSchema,
  ticketRatingSchema,
  ticketReplySchema,
  type AccountHealthMetric,
  type SellerSupportSummary,
  type SupportTicketDetail,
  type SupportTicketPage,
  type SupportTicketRow,
  type TicketCategory,
  type TicketPriorityValue,
  type TicketStatusValue,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { requireSeller } from './seller';

export const sellerSupportRouter = Router();
sellerSupportRouter.use(requireAuth, requireSeller);

/** Orders must be dispatched inside this many days to count as on time. */
const DISPATCH_SLA_DAYS = 2;
/** Health rates are measured over this window. */
const HEALTH_WINDOW_DAYS = 90;

const listQuery = z.object({
  status: z.enum(['ALL', ...TICKET_STATUSES]).default('ALL'),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10),
});

const TICKET_INCLUDE = {
  messages: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { name: true } } },
  },
} satisfies Prisma.SupportTicketInclude;

type TicketRecord = Prisma.SupportTicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

function toRow(ticket: TicketRecord): SupportTicketRow {
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

/** TK-000001 upward, across the platform. */
async function nextReference(): Promise<string> {
  const count = await prisma.supportTicket.count();
  return `TK-${String(count + 1).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Account health — every rate measured from this seller's real orders
// ---------------------------------------------------------------------------

function rate(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function ratingFor(value: number, target: number): AccountHealthMetric['rating'] {
  if (value <= target) return 'GOOD';
  if (value <= target * 2) return 'WATCH';
  return 'POOR';
}

export async function accountHealth(sellerId: string): Promise<SellerSupportSummary['health']> {
  const since = new Date(Date.now() - HEALTH_WINDOW_DAYS * 86400000);
  // The seller sets their own dispatch promise in Store Settings.
  const seller = await prisma.sellerProfile.findUnique({
    where: { id: sellerId },
    select: { dispatchDays: true },
  });
  const dispatchDays = seller?.dispatchDays ?? DISPATCH_SLA_DAYS;
  const items = await prisma.orderItem.findMany({
    where: { sellerId, order: { status: { not: 'PLACED' }, createdAt: { gte: since } } },
    select: {
      status: true,
      quantity: true,
      shippedAt: true,
      order: { select: { createdAt: true } },
      return: { select: { reasonCategory: true } },
    },
  });

  const units = items.reduce((sum, i) => sum + i.quantity, 0);
  const deliveredUnits = items
    .filter((i) => ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'].includes(i.status))
    .reduce((sum, i) => sum + i.quantity, 0);
  const cancelledUnits = items
    .filter((i) => i.status === 'CANCELLED')
    .reduce((sum, i) => sum + i.quantity, 0);
  const returnedUnits = items
    .filter((i) => ['RETURNED', 'RETURN_REQUESTED'].includes(i.status))
    .reduce((sum, i) => sum + i.quantity, 0);

  // A defect is a return the seller caused: damaged, wrong item or quality.
  const defectUnits = items
    .filter(
      (i) =>
        i.return && ['DAMAGED', 'WRONG_ITEM', 'QUALITY'].includes(i.return.reasonCategory),
    )
    .reduce((sum, i) => sum + i.quantity, 0);

  const shipped = items.filter((i) => i.shippedAt);
  const lateShipped = shipped.filter(
    (i) =>
      i.shippedAt!.getTime() - i.order.createdAt.getTime() > dispatchDays * 86400000,
  );

  const metrics: AccountHealthMetric[] = [
    {
      key: 'defect',
      label: 'Order defect rate',
      value: rate(defectUnits, deliveredUnits),
      target: 2,
      rating: ratingFor(rate(defectUnits, deliveredUnits), 2),
      detail: `${defectUnits} of ${deliveredUnits} delivered units came back damaged, wrong or below quality`,
    },
    {
      key: 'late',
      label: 'Late dispatch rate',
      value: rate(lateShipped.length, shipped.length),
      target: 5,
      rating: ratingFor(rate(lateShipped.length, shipped.length), 5),
      detail: `${lateShipped.length} of ${shipped.length} shipments left later than your ${dispatchDays}-day promise`,
    },
    {
      key: 'cancel',
      label: 'Cancellation rate',
      value: rate(cancelledUnits, units),
      target: 3,
      rating: ratingFor(rate(cancelledUnits, units), 3),
      detail: `${cancelledUnits} of ${units} units were cancelled after payment`,
    },
    {
      key: 'return',
      label: 'Return rate',
      value: rate(returnedUnits, deliveredUnits),
      target: 10,
      rating: ratingFor(rate(returnedUnits, deliveredUnits), 10),
      detail: `${returnedUnits} of ${deliveredUnits} delivered units were returned`,
    },
  ];

  const poor = metrics.filter((m) => m.rating === 'POOR');
  const watch = metrics.filter((m) => m.rating === 'WATCH');
  const overall = poor.length > 0 ? 'POOR' : watch.length > 0 ? 'WATCH' : 'GOOD';

  return {
    overall,
    summary:
      overall === 'GOOD'
        ? 'No issues found — every metric is inside its target.'
        : overall === 'WATCH'
          ? `Keep an eye on ${watch.map((m) => m.label.toLowerCase()).join(' and ')}.`
          : `${poor.map((m) => m.label.toLowerCase()).join(' and ')} ${poor.length > 1 ? 'are' : 'is'} well above target — fix this to protect your account.`,
    metrics,
    sampleSize: items.length,
  };
}

// ---------------------------------------------------------------------------
// GET /summary — ticket counts, response time, account health
// ---------------------------------------------------------------------------

sellerSupportRouter.get('/summary', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const [tickets, health] = await Promise.all([
      prisma.supportTicket.findMany({
        where: { sellerId },
        orderBy: { lastMessageAt: 'desc' },
        include: TICKET_INCLUDE,
      }),
      accountHealth(sellerId),
    ]);

    const rows = tickets.map(toRow);
    const responded = rows
      .map((r) => r.firstResponseMinutes)
      .filter((m): m is number => m !== null)
      .sort((a, b) => a - b);
    // Median, not mean — one slow ticket shouldn't define the number.
    const median =
      responded.length > 0 ? responded[Math.floor(responded.length / 2)] : null;
    const rated = rows.filter((r) => r.rating !== null);

    const body: SellerSupportSummary = {
      tickets: {
        open: rows.filter((r) => r.status === 'OPEN').length,
        inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
        resolved: rows.filter((r) => r.status === 'RESOLVED' || r.status === 'CLOSED').length,
        avgResponseMinutes: median,
        satisfaction:
          rated.length > 0
            ? Math.round((rated.reduce((sum, r) => sum + (r.rating ?? 0), 0) / rated.length) * 10) /
              10
            : null,
        ratedCount: rated.length,
      },
      health,
      recentTickets: rows.slice(0, 5),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

sellerSupportRouter.get('/tickets', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const where: Prisma.SupportTicketWhereInput = {
      sellerId: req.seller!.id,
      ...(query.status !== 'ALL' ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { subject: { contains: query.q, mode: 'insensitive' } },
              { reference: { contains: query.q.toUpperCase() } },
              { orderNumber: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, tickets] = await Promise.all([
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
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

sellerSupportRouter.post('/tickets', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const input = ticketCreateSchema.parse(req.body);

    const open = await prisma.supportTicket.count({
      where: { sellerId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    });
    if (open >= 20) {
      throw ApiError.badRequest(
        'You already have 20 open tickets — please continue on an existing one',
        'TOO_MANY_TICKETS',
      );
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        reference: await nextReference(),
        sellerId,
        category: input.category,
        subject: input.subject,
        priority: input.priority,
        orderNumber: input.orderNumber || null,
        productId: input.productId || null,
        lastMessageAt: new Date(),
        messages: {
          create: {
            authorId: req.auth!.userId,
            authorRole: 'SELLER',
            body: input.body,
            attachments: input.attachments,
          },
        },
      },
      include: TICKET_INCLUDE,
    });

    res.json({ success: true, data: toDetail(ticket) });
  } catch (err) {
    next(err);
  }
});

sellerSupportRouter.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: req.params.id, sellerId: req.seller!.id },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');
    res.json({ success: true, data: toDetail(ticket) });
  } catch (err) {
    next(err);
  }
});

sellerSupportRouter.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const input = ticketReplySchema.parse(req.body);
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: req.params.id, sellerId: req.seller!.id },
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');
    if (ticket.status === 'CLOSED') {
      throw ApiError.badRequest('This ticket is closed — open a new one', 'TICKET_CLOSED');
    }

    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        lastMessageAt: new Date(),
        // A reply on a resolved ticket reopens the conversation.
        status: ticket.status === 'RESOLVED' ? 'OPEN' : ticket.status,
        resolvedAt: ticket.status === 'RESOLVED' ? null : ticket.resolvedAt,
        messages: {
          create: {
            authorId: req.auth!.userId,
            authorRole: 'SELLER',
            body: input.body,
            attachments: input.attachments,
          },
        },
      },
      include: TICKET_INCLUDE,
    });
    res.json({ success: true, data: toDetail(updated) });
  } catch (err) {
    next(err);
  }
});

/** The seller closing their own ticket. */
sellerSupportRouter.post('/tickets/:id/close', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: req.params.id, sellerId: req.seller!.id },
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');

    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'CLOSED', closedAt: new Date(), resolvedAt: ticket.resolvedAt ?? new Date() },
      include: TICKET_INCLUDE,
    });
    res.json({ success: true, data: toDetail(updated) });
  } catch (err) {
    next(err);
  }
});

/** Rate the support you received — only once the ticket is settled. */
sellerSupportRouter.post('/tickets/:id/rating', async (req, res, next) => {
  try {
    const input = ticketRatingSchema.parse(req.body);
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: req.params.id, sellerId: req.seller!.id },
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');
    if (ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED') {
      throw ApiError.badRequest('You can rate a ticket once it is resolved', 'TICKET_OPEN');
    }

    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { rating: input.rating, ratingComment: input.comment?.trim() || null },
      include: TICKET_INCLUDE,
    });
    res.json({ success: true, data: toDetail(updated) });
  } catch (err) {
    next(err);
  }
});
