import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_CATEGORY_LABELS,
  DESK_PRIORITIES,
  DESK_SORTS,
  DESK_STATUSES,
  DESK_STATUS_LABELS,
  DESK_TABS,
  SLA_RESPONSE_HOURS,
  SUPPORT_CHANNELS,
  SUPPORT_CHANNEL_LABELS,
  deskBulkSchema,
  deskReplySchema,
  deskUpdateSchema,
  type DeskPriority,
  type DeskSort,
  type DeskStatus,
  type SlaState,
  type SupportAgent,
  type SupportChannelValue,
  type SupportDeskPage,
  type SupportDeskSummary,
  type SupportTicketDeskDetail,
  type SupportTicketDeskRow,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { sendToUserSafe } from '../services/messaging';

export const adminSupportDeskRouter = Router();
adminSupportDeskRouter.use(requireAuth, requireRole('ADMIN'));

const SCAN_CAP = 5000;
/** Inside this fraction of the SLA window a ticket is flagged at risk. */
const AT_RISK_FRACTION = 0.75;

const PRIORITY_RANK: Record<DeskPriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const listQuery = z.object({
  tab: z.enum(DESK_TABS).default('ALL'),
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().optional(),
  channel: z.string().trim().optional(),
  priority: z.string().trim().optional(),
  agentId: z.string().trim().optional(),
  sla: z.enum(['ALL', 'BREACHED', 'AT_RISK']).default('ALL'),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: z.enum(DESK_SORTS).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});

const TICKET_INCLUDE = {
  user: { select: { id: true, name: true, email: true, phone: true } },
  order: { select: { orderNumber: true } },
  assignedTo: { select: { id: true, name: true } },
  messages: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { name: true } } },
  },
} satisfies Prisma.ComplaintInclude;

type TicketRecord = Prisma.ComplaintGetPayload<{ include: typeof TICKET_INCLUDE }>;

/**
 * Where the ticket stands against its response target. A settled ticket is
 * judged on whether the first reply landed in time; a live one on the clock.
 */
function slaStateOf(ticket: {
  slaDueAt: Date | null;
  firstResponseAt: Date | null;
  createdAt: Date;
  status: string;
}): SlaState {
  if (!ticket.slaDueAt) return 'ON_TRACK';
  if (ticket.firstResponseAt) {
    return ticket.firstResponseAt <= ticket.slaDueAt ? 'MET' : 'BREACHED';
  }
  const now = Date.now();
  if (now > ticket.slaDueAt.getTime()) return 'BREACHED';
  const window = ticket.slaDueAt.getTime() - ticket.createdAt.getTime();
  const elapsed = now - ticket.createdAt.getTime();
  return elapsed / window >= AT_RISK_FRACTION ? 'AT_RISK' : 'ON_TRACK';
}

function minutesBetween(from: Date, to: Date | null): number | null {
  if (!to) return null;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
}

function toRow(ticket: TicketRecord): SupportTicketDeskRow {
  const visible = ticket.messages.filter((m) => !m.isInternal);
  const last = visible[visible.length - 1];
  const category = ticket.category as keyof typeof COMPLAINT_CATEGORY_LABELS;
  return {
    id: ticket.id,
    reference: ticket.complaintId,
    customer: {
      id: ticket.user.id,
      name: ticket.user.name,
      email: ticket.user.email,
      phone: ticket.user.phone,
    },
    subject: ticket.subject ?? COMPLAINT_CATEGORY_LABELS[category] ?? 'Support request',
    category: ticket.category,
    categoryLabel: COMPLAINT_CATEGORY_LABELS[category] ?? ticket.category,
    channel: ticket.channel as SupportChannelValue,
    channelLabel: SUPPORT_CHANNEL_LABELS[ticket.channel as SupportChannelValue],
    priority: ticket.priority as DeskPriority,
    status: ticket.status as DeskStatus,
    statusLabel: DESK_STATUS_LABELS[ticket.status as DeskStatus],
    orderNumber: ticket.order?.orderNumber ?? null,
    assignedTo: ticket.assignedTo
      ? { id: ticket.assignedTo.id, name: ticket.assignedTo.name }
      : null,
    slaDueAt: ticket.slaDueAt?.toISOString() ?? null,
    slaState: slaStateOf(ticket),
    firstResponseMinutes: minutesBetween(ticket.createdAt, ticket.firstResponseAt),
    resolutionMinutes: minutesBetween(ticket.createdAt, ticket.resolvedAt),
    messageCount: visible.length,
    lastMessage: last ? last.body.slice(0, 140) : ticket.description.slice(0, 140),
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    rating: ticket.rating,
    createdAt: ticket.createdAt.toISOString(),
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
  };
}

function compare(a: SupportTicketDeskRow, b: SupportTicketDeskRow, sort: DeskSort): number {
  switch (sort) {
    case 'OLDEST':
      return a.createdAt.localeCompare(b.createdAt);
    case 'PRIORITY':
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case 'SLA_URGENT': {
      const rank: Record<SlaState, number> = { BREACHED: 0, AT_RISK: 1, ON_TRACK: 2, MET: 3 };
      return rank[a.slaState] - rank[b.slaState] || a.createdAt.localeCompare(b.createdAt);
    }
    default:
      return b.createdAt.localeCompare(a.createdAt);
  }
}

function buildWhere(query: z.infer<typeof listQuery>): Prisma.ComplaintWhereInput {
  const where: Prisma.ComplaintWhereInput = {};
  if (query.tab !== 'ALL') where.status = query.tab as DeskStatus;
  if (query.category) where.category = query.category;
  if (query.channel) where.channel = query.channel as SupportChannelValue;
  if (query.priority) where.priority = query.priority as DeskPriority;
  if (query.agentId) where.assignedToId = query.agentId === 'UNASSIGNED' ? null : query.agentId;

  const gte = query.from ? new Date(`${query.from}T00:00:00`) : null;
  const lte = query.to ? new Date(`${query.to}T23:59:59.999`) : null;
  if ((gte && !Number.isNaN(gte.getTime())) || (lte && !Number.isNaN(lte.getTime()))) {
    where.createdAt = {
      ...(gte && !Number.isNaN(gte.getTime()) ? { gte } : {}),
      ...(lte && !Number.isNaN(lte.getTime()) ? { lte } : {}),
    };
  }

  if (query.q) {
    where.OR = [
      { complaintId: { contains: query.q.toUpperCase() } },
      { subject: { contains: query.q, mode: 'insensitive' } },
      { description: { contains: query.q, mode: 'insensitive' } },
      { user: { name: { contains: query.q, mode: 'insensitive' } } },
      { user: { phone: { contains: query.q } } },
      { user: { email: { contains: query.q, mode: 'insensitive' } } },
      { order: { orderNumber: { contains: query.q, mode: 'insensitive' } } },
    ];
  }
  return where;
}

async function loadRows(query: z.infer<typeof listQuery>): Promise<SupportTicketDeskRow[]> {
  const tickets = await prisma.complaint.findMany({
    where: buildWhere(query),
    orderBy: { createdAt: 'desc' },
    take: SCAN_CAP,
    include: TICKET_INCLUDE,
  });
  return tickets
    .map(toRow)
    // SLA is derived, so it filters after mapping.
    .filter((r) => query.sla === 'ALL' || r.slaState === query.sla)
    .sort((a, b) => compare(a, b, query.sort));
}

// ---------------------------------------------------------------------------
// GET / — the ticket queue
// ---------------------------------------------------------------------------

adminSupportDeskRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const rows = await loadRows(query);
    const body: SupportDeskPage = {
      rows: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(rows.length / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /summary — KPIs, channel/category splits, SLA, agents, feedback
// ---------------------------------------------------------------------------

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

adminSupportDeskRouter.get('/summary', async (req, res, next) => {
  try {
    const query = listQuery.parse({ ...req.query, tab: 'ALL' });
    const rows = await loadRows(query);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const createdIn = (from: Date, to?: Date) =>
      rows.filter((r) => {
        const at = new Date(r.createdAt);
        return at >= from && (!to || at < to);
      }).length;

    const share = (n: number) => (rows.length > 0 ? Math.round((n / rows.length) * 1000) / 10 : 0);
    const countBy = <T extends string>(pick: (r: SupportTicketDeskRow) => T) => {
      const map = new Map<T, number>();
      for (const r of rows) map.set(pick(r), (map.get(pick(r)) ?? 0) + 1);
      return map;
    };

    const byStatus = countBy((r) => r.status);
    const byChannel = countBy((r) => r.channel);
    const byCategory = countBy((r) => r.category);

    const met = rows.filter((r) => r.slaState === 'MET').length;
    const breached = rows.filter((r) => r.slaState === 'BREACHED').length;
    const inFlight = rows.filter(
      (r) => r.slaState === 'ON_TRACK' || r.slaState === 'AT_RISK',
    ).length;
    const settled = met + breached;

    const resolutionTimes = rows
      .map((r) => r.resolutionMinutes)
      .filter((m): m is number => m !== null)
      .sort((a, b) => a - b);

    // Daily created/resolved over the last 30 days.
    const trend = new Map<string, { created: number; resolved: number }>();
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(now.getTime() - i * 86400000);
      trend.set(dayKey(d), { created: 0, resolved: 0 });
    }
    for (const row of rows) {
      const created = trend.get(dayKey(new Date(row.createdAt)));
      if (created) created.created += 1;
      if (row.resolvedAt) {
        const resolved = trend.get(dayKey(new Date(row.resolvedAt)));
        if (resolved) resolved.resolved += 1;
      }
    }

    const rated = rows.filter((r) => r.rating !== null);
    const distribution = [5, 4, 3, 2, 1].map((stars) => {
      const count = rated.filter((r) => r.rating === stars).length;
      return {
        stars,
        count,
        share: rated.length > 0 ? Math.round((count / rated.length) * 1000) / 10 : 0,
      };
    });

    // Agents are admin accounts; their load comes from assignments.
    const adminUsers = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true, name: true, email: true },
    });
    const agents: SupportAgent[] = adminUsers.map((a) => {
      const mine = rows.filter((r) => r.assignedTo?.id === a.id);
      const responses = mine
        .map((r) => r.firstResponseMinutes)
        .filter((m): m is number => m !== null)
        .sort((x, y) => x - y);
      return {
        id: a.id,
        name: a.name,
        email: a.email,
        openTickets: mine.filter((r) => ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER'].includes(r.status))
          .length,
        resolvedTickets: mine.filter((r) => ['RESOLVED', 'CLOSED'].includes(r.status)).length,
        medianResponseMinutes:
          responses.length > 0 ? responses[Math.floor(responses.length / 2)] : null,
      };
    });

    const body: SupportDeskSummary = {
      kpis: {
        total: rows.length,
        totalChangePercent: changePercent(
          createdIn(monthStart),
          createdIn(prevMonthStart, monthStart),
        ),
        open: byStatus.get('OPEN') ?? 0,
        inProgress: byStatus.get('IN_PROGRESS') ?? 0,
        pendingCustomer: byStatus.get('PENDING_CUSTOMER') ?? 0,
        resolved: (byStatus.get('RESOLVED') ?? 0) + (byStatus.get('CLOSED') ?? 0),
        slaMetPercent: settled > 0 ? Math.round((met / settled) * 1000) / 10 : 100,
        // Median, so one runaway ticket doesn't define the headline.
        avgResolutionMinutes:
          resolutionTimes.length > 0
            ? resolutionTimes[Math.floor(resolutionTimes.length / 2)]
            : null,
      },
      byStatus: DESK_STATUSES.map((key) => ({
        key,
        label: DESK_STATUS_LABELS[key],
        count: byStatus.get(key) ?? 0,
        share: share(byStatus.get(key) ?? 0),
      })).filter((s) => s.count > 0),
      byChannel: SUPPORT_CHANNELS.map((key) => ({
        key,
        label: SUPPORT_CHANNEL_LABELS[key],
        count: byChannel.get(key) ?? 0,
        share: share(byChannel.get(key) ?? 0),
      })).filter((c) => c.count > 0),
      byCategory: COMPLAINT_CATEGORIES.map((key) => ({
        key,
        label: COMPLAINT_CATEGORY_LABELS[key],
        count: byCategory.get(key) ?? 0,
        share: share(byCategory.get(key) ?? 0),
      }))
        .filter((c) => c.count > 0)
        .sort((a, b) => b.count - a.count),
      sla: {
        met,
        breached,
        inFlight,
        metPercent: settled > 0 ? Math.round((met / settled) * 1000) / 10 : 100,
      },
      trend: [...trend.entries()].map(([date, v]) => ({ date, ...v })),
      satisfaction: {
        average:
          rated.length > 0
            ? Math.round((rated.reduce((sum, r) => sum + (r.rating ?? 0), 0) / rated.length) * 100) /
              100
            : null,
        ratedCount: rated.length,
        distribution,
      },
      agents: agents.sort((a, b) => b.openTickets - a.openTickets),
      recentFeedback: [],
    };

    // Recent feedback needs the comment, which the row shape doesn't carry.
    const feedback = await prisma.complaint.findMany({
      where: { rating: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: 4,
      include: { user: { select: { name: true } } },
    });
    body.recentFeedback = feedback.map((f) => ({
      id: f.id,
      reference: f.complaintId,
      customerName: f.user.name,
      rating: f.rating!,
      comment: f.ratingComment,
      channel: f.channel as SupportChannelValue,
      createdAt: f.updatedAt.toISOString(),
    }));

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — one ticket with its conversation
// ---------------------------------------------------------------------------

adminSupportDeskRouter.get('/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.complaint.findUnique({
      where: { id: req.params.id },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');

    const history = await prisma.complaint.findMany({
      where: { userId: ticket.userId, id: { not: ticket.id } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, complaintId: true, subject: true, category: true, status: true, createdAt: true },
    });

    const body: SupportTicketDeskDetail = {
      ...toRow(ticket),
      description: ticket.description,
      adminNotes: ticket.adminNotes,
      ratingComment: ticket.ratingComment,
      messages: ticket.messages.map((m) => ({
        id: m.id,
        authorRole: m.authorRole as 'CUSTOMER' | 'AGENT' | 'SYSTEM',
        authorName: m.author?.name ?? null,
        body: m.body,
        attachments: m.attachments,
        isInternal: m.isInternal,
        createdAt: m.createdAt.toISOString(),
      })),
      customerHistory: history.map((h) => ({
        id: h.id,
        reference: h.complaintId,
        subject: h.subject ?? h.category,
        status: h.status as DeskStatus,
        createdAt: h.createdAt.toISOString(),
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/reply — agent reply or internal note
// ---------------------------------------------------------------------------

adminSupportDeskRouter.post('/:id/reply', async (req, res, next) => {
  try {
    const input = deskReplySchema.parse(req.body);
    const ticket = await prisma.complaint.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, phone: true } } },
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');

    const now = new Date();
    const updated = await prisma.complaint.update({
      where: { id: ticket.id },
      data: {
        lastMessageAt: now,
        // Only a reply the customer can see stops the SLA clock.
        ...(input.isInternal || ticket.firstResponseAt ? {} : { firstResponseAt: now }),
        ...(input.isInternal || ticket.status !== 'OPEN' ? {} : { status: 'IN_PROGRESS' as const }),
        messages: {
          create: {
            authorId: req.auth!.userId,
            authorRole: 'AGENT',
            body: input.body,
            attachments: input.attachments,
            isInternal: input.isInternal,
          },
        },
      },
      include: TICKET_INCLUDE,
    });

    if (!input.isInternal) {
      await prisma.notification.create({
        data: {
          userId: ticket.user.id,
          type: 'COMPLAINT_UPDATED',
          title: `Support replied on ${ticket.complaintId}`,
          body: input.body.slice(0, 160),
          linkHref: '/complaints',
        },
      });
      sendToUserSafe(ticket.user.id, {
        channel: 'whatsapp',
        to: `+91${ticket.user.phone}`,
        body: `Clowe support replied on ${ticket.complaintId}: ${input.body.slice(0, 120)}`,
      });
    }

    res.json({ success: true, data: toRow(updated) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id — assign, reprioritise, recategorise, change status
// ---------------------------------------------------------------------------

adminSupportDeskRouter.patch('/:id', async (req, res, next) => {
  try {
    const input = deskUpdateSchema.parse(req.body);
    const ticket = await prisma.complaint.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true } } },
    });
    if (!ticket) throw ApiError.notFound('Ticket not found');

    const now = new Date();
    // Re-prioritising moves the response target with it, measured from
    // creation, so an urgent escalation doesn't reset the clock.
    const nextPriority = (input.priority ?? ticket.priority) as DeskPriority;
    const slaDueAt =
      input.priority && input.priority !== ticket.priority
        ? new Date(ticket.createdAt.getTime() + SLA_RESPONSE_HOURS[nextPriority] * 3600000)
        : ticket.slaDueAt;

    const updated = await prisma.complaint.update({
      where: { id: ticket.id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.priority ? { priority: input.priority, slaDueAt } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.adminNotes !== undefined ? { adminNotes: input.adminNotes || null } : {}),
        ...(input.assignedToId !== undefined
          ? {
              assignedToId: input.assignedToId || null,
              assignedAt: input.assignedToId ? now : null,
            }
          : {}),
        ...(input.status === 'RESOLVED' ? { resolvedAt: ticket.resolvedAt ?? now } : {}),
        ...(input.status === 'CLOSED'
          ? { closedAt: now, resolvedAt: ticket.resolvedAt ?? now }
          : {}),
      },
      include: TICKET_INCLUDE,
    });

    if (input.status === 'RESOLVED') {
      await prisma.notification.create({
        data: {
          userId: ticket.user.id,
          type: 'COMPLAINT_UPDATED',
          title: `${ticket.complaintId} resolved`,
          body: 'Your support request is marked resolved. Rate the help you received, or reply to reopen it.',
          linkHref: '/complaints',
        },
      });
    }

    res.json({ success: true, data: toRow(updated) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /bulk — assign / status / priority across many tickets
// ---------------------------------------------------------------------------

adminSupportDeskRouter.post('/bulk', async (req, res, next) => {
  try {
    const input = deskBulkSchema.parse(req.body);
    const now = new Date();
    let updated = 0;
    const skipped: { id: string; reason: string }[] = [];

    for (const id of input.ids) {
      const ticket = await prisma.complaint.findUnique({ where: { id } });
      if (!ticket) {
        skipped.push({ id, reason: 'Ticket not found' });
        continue;
      }
      try {
        if (input.action === 'ASSIGN') {
          await prisma.complaint.update({
            where: { id },
            data: {
              assignedToId: input.assignedToId || null,
              assignedAt: input.assignedToId ? now : null,
            },
          });
        } else if (input.action === 'STATUS' && input.status) {
          await prisma.complaint.update({
            where: { id },
            data: {
              status: input.status,
              ...(input.status === 'RESOLVED' ? { resolvedAt: ticket.resolvedAt ?? now } : {}),
              ...(input.status === 'CLOSED'
                ? { closedAt: now, resolvedAt: ticket.resolvedAt ?? now }
                : {}),
            },
          });
        } else if (input.action === 'PRIORITY' && input.priority) {
          await prisma.complaint.update({
            where: { id },
            data: {
              priority: input.priority,
              slaDueAt: new Date(
                ticket.createdAt.getTime() + SLA_RESPONSE_HOURS[input.priority] * 3600000,
              ),
            },
          });
        } else {
          skipped.push({ id, reason: 'Nothing to apply for that action' });
          continue;
        }
        updated += 1;
      } catch {
        skipped.push({ id, reason: 'Could not update this ticket' });
      }
    }

    res.json({ success: true, data: { updated, skipped } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /meta/agents — who tickets can be assigned to
// ---------------------------------------------------------------------------

adminSupportDeskRouter.get('/meta/agents', async (_req, res, next) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
    });
    res.json({ success: true, data: admins });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /meta/export — the filtered queue as CSV
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

adminSupportDeskRouter.get('/meta/export', async (req, res, next) => {
  try {
    const rows = await loadRows(listQuery.parse(req.query));
    const header = [
      'Ticket ID',
      'Created',
      'Customer',
      'Phone',
      'Email',
      'Subject',
      'Category',
      'Channel',
      'Priority',
      'Status',
      'Assigned to',
      'SLA',
      'First response (min)',
      'Resolution (min)',
      'Order',
      'Rating',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.reference,
          r.createdAt,
          r.customer.name ?? '',
          r.customer.phone,
          r.customer.email ?? '',
          r.subject,
          r.categoryLabel,
          r.channelLabel,
          r.priority,
          r.status,
          r.assignedTo?.name ?? 'Unassigned',
          r.slaState,
          r.firstResponseMinutes ?? '',
          r.resolutionMinutes ?? '',
          r.orderNumber ?? '',
          r.rating ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clowe-support-tickets.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

export { DESK_PRIORITIES };
