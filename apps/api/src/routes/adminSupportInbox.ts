import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  COMPLAINT_CATEGORY_LABELS,
  inboxListQuerySchema,
  type InboxKind,
  type InboxMessage,
  type InboxPage,
  type InboxRow,
  type InboxStatus,
  type InboxThread,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

// ---------------------------------------------------------------------------
// GET /api/admin/support-inbox — seller tickets and customer complaints as
// one list of conversations, newest activity first, with unread counts.
// GET /api/admin/support-inbox/:kind/:id — one conversation; opening it marks
// it read. Replying and status changes use each kind's own endpoints.
// ---------------------------------------------------------------------------

export const adminSupportInboxRouter = Router();
adminSupportInboxRouter.use(requireAuth, requireRole('ADMIN'));

/** Per kind, the most recent conversations considered for the list. */
const LIST_CAP = 150;
const ACTIVE: InboxStatus[] = ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER'];

const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 140);

/** Their messages since an admin last opened each conversation. */
async function unreadCounts(kind: InboxKind, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows =
    kind === 'SELLER'
      ? await prisma.$queryRaw<Array<{ id: string; unread: number }>>(Prisma.sql`
          SELECT t.id, COUNT(m.id)::int AS unread
          FROM support_tickets t
          JOIN support_ticket_messages m ON m."ticketId" = t.id
          WHERE t.id IN (${Prisma.join(ids)}) AND m."authorRole" = 'SELLER'
            AND (t."adminReadAt" IS NULL OR m."createdAt" > t."adminReadAt")
          GROUP BY t.id`)
      : await prisma.$queryRaw<Array<{ id: string; unread: number }>>(Prisma.sql`
          SELECT c.id, COUNT(m.id)::int AS unread
          FROM complaints c
          JOIN complaint_messages m ON m."complaintId" = c.id
          WHERE c.id IN (${Prisma.join(ids)}) AND m."authorRole" = 'CUSTOMER'
            AND (c."adminReadAt" IS NULL OR m."createdAt" > c."adminReadAt")
          GROUP BY c.id`);
  return new Map(rows.map((r) => [r.id, r.unread]));
}

async function sellerRows(statuses: InboxStatus[] | null, q: string | undefined): Promise<InboxRow[]> {
  // A seller ticket has no PENDING_CUSTOMER.
  const ticketStatuses = statuses?.filter((s) => s !== 'PENDING_CUSTOMER') as
    | Array<'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'>
    | undefined;
  if (ticketStatuses && ticketStatuses.length === 0) return [];
  const tickets = await prisma.supportTicket.findMany({
    where: {
      ...(ticketStatuses ? { status: { in: ticketStatuses } } : {}),
      ...(q
        ? {
            OR: [
              { subject: { contains: q, mode: 'insensitive' } },
              { reference: { contains: q.toUpperCase() } },
              { seller: { shopName: { contains: q, mode: 'insensitive' } } },
              { orderNumber: { contains: q.toUpperCase() } },
            ],
          }
        : {}),
    },
    orderBy: { lastMessageAt: 'desc' },
    take: LIST_CAP,
    include: {
      seller: { select: { shopName: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, authorRole: true } },
    },
  });
  const unread = await unreadCounts('SELLER', tickets.map((t) => t.id));
  return tickets.map((t) => ({
    kind: 'SELLER',
    id: t.id,
    reference: t.reference,
    name: t.seller.shopName,
    subject: t.subject,
    lastMessage: preview(t.messages[0]?.body ?? ''),
    lastFrom: t.messages[0]?.authorRole === 'ADMIN' ? 'US' : 'THEM',
    lastMessageAt: t.lastMessageAt.toISOString(),
    status: t.status as InboxStatus,
    priority: t.priority,
    unread: unread.get(t.id) ?? 0,
  }));
}

async function customerRows(statuses: InboxStatus[] | null, q: string | undefined): Promise<InboxRow[]> {
  const complaints = await prisma.complaint.findMany({
    where: {
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(q
        ? {
            OR: [
              { subject: { contains: q, mode: 'insensitive' } },
              { complaintId: { contains: q.toUpperCase() } },
              { user: { name: { contains: q, mode: 'insensitive' } } },
              { user: { phone: { contains: q } } },
              { order: { orderNumber: { contains: q.toUpperCase() } } },
            ],
          }
        : {}),
    },
    orderBy: { lastMessageAt: 'desc' },
    take: LIST_CAP,
    include: {
      user: { select: { name: true, phone: true } },
      // The latest message the customer could see: internal notes are not the conversation.
      messages: { where: { isInternal: false }, orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, authorRole: true } },
    },
  });
  const unread = await unreadCounts('CUSTOMER', complaints.map((c) => c.id));
  return complaints.map((c) => {
    const category = c.category as keyof typeof COMPLAINT_CATEGORY_LABELS;
    return {
      kind: 'CUSTOMER',
      id: c.id,
      reference: c.complaintId,
      name: c.user.name?.trim() || `+91 ${c.user.phone}`,
      subject: c.subject ?? COMPLAINT_CATEGORY_LABELS[category] ?? 'Support request',
      lastMessage: preview(c.messages[0]?.body ?? c.description),
      lastFrom: c.messages[0]?.authorRole === 'CUSTOMER' || !c.messages[0] ? 'THEM' : 'US',
      lastMessageAt: c.lastMessageAt.toISOString(),
      status: c.status as InboxStatus,
      priority: c.priority,
      unread: unread.get(c.id) ?? 0,
    };
  });
}

adminSupportInboxRouter.get('/', async (req, res, next) => {
  try {
    const query = inboxListQuerySchema.parse(req.query);
    const statuses = query.status === 'ALL' ? null : query.status === 'ACTIVE' ? ACTIVE : [query.status];
    const [sellers, customers] = await Promise.all([
      query.kind === 'CUSTOMER' ? [] : sellerRows(statuses, query.q),
      query.kind === 'SELLER' ? [] : customerRows(statuses, query.q),
    ]);
    const rows = [...sellers, ...customers].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    const body: InboxPage = { rows, unreadTotal: rows.reduce((sum, r) => sum + r.unread, 0) };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

adminSupportInboxRouter.get('/:kind/:id', async (req, res, next) => {
  try {
    const kind = req.params.kind.toUpperCase() as InboxKind;
    const id = req.params.id;
    let body: InboxThread;
    if (kind === 'SELLER') {
      const t = await prisma.supportTicket.findUnique({
        where: { id },
        include: {
          seller: { select: { shopName: true } },
          messages: { orderBy: { createdAt: 'asc' }, include: { author: { select: { name: true } } } },
        },
      });
      if (!t) throw ApiError.notFound('Ticket not found');
      await prisma.supportTicket.update({ where: { id }, data: { adminReadAt: new Date() } });
      const messages: InboxMessage[] = t.messages.map((m) => ({
        id: m.id,
        from: m.authorRole === 'ADMIN' ? 'US' : 'THEM',
        authorName: m.authorRole === 'ADMIN' ? (m.author.name ?? 'Clowe support') : t.seller.shopName,
        body: m.body,
        attachments: m.attachments,
        internal: false,
        createdAt: m.createdAt.toISOString(),
      }));
      const last = t.messages[t.messages.length - 1];
      body = {
        row: {
          kind,
          id: t.id,
          reference: t.reference,
          name: t.seller.shopName,
          subject: t.subject,
          lastMessage: preview(last?.body ?? ''),
          lastFrom: last?.authorRole === 'ADMIN' ? 'US' : 'THEM',
          lastMessageAt: t.lastMessageAt.toISOString(),
          status: t.status as InboxStatus,
          priority: t.priority,
          unread: 0,
        },
        orderNumber: t.orderNumber,
        category: t.category,
        messages,
      };
    } else if (kind === 'CUSTOMER') {
      const c = await prisma.complaint.findUnique({
        where: { id },
        include: {
          user: { select: { name: true, phone: true } },
          order: { select: { orderNumber: true } },
          messages: { orderBy: { createdAt: 'asc' }, include: { author: { select: { name: true } } } },
        },
      });
      if (!c) throw ApiError.notFound('Ticket not found');
      await prisma.complaint.update({ where: { id }, data: { adminReadAt: new Date() } });
      const name = c.user.name?.trim() || `+91 ${c.user.phone}`;
      const category = c.category as keyof typeof COMPLAINT_CATEGORY_LABELS;
      const visible = c.messages.filter((m) => !m.isInternal);
      const last = visible[visible.length - 1];
      body = {
        row: {
          kind,
          id: c.id,
          reference: c.complaintId,
          name,
          subject: c.subject ?? COMPLAINT_CATEGORY_LABELS[category] ?? 'Support request',
          lastMessage: preview(last?.body ?? c.description),
          lastFrom: last?.authorRole === 'CUSTOMER' || !last ? 'THEM' : 'US',
          lastMessageAt: c.lastMessageAt.toISOString(),
          status: c.status as InboxStatus,
          priority: c.priority,
          unread: 0,
        },
        orderNumber: c.order?.orderNumber ?? null,
        category: COMPLAINT_CATEGORY_LABELS[category] ?? c.category,
        messages: c.messages.map((m) => ({
          id: m.id,
          from: m.authorRole === 'CUSTOMER' ? 'THEM' : m.authorRole === 'SYSTEM' ? 'SYSTEM' : 'US',
          authorName: m.authorRole === 'CUSTOMER' ? name : (m.author?.name ?? (m.authorRole === 'SYSTEM' ? null : 'Clowe support')),
          body: m.body,
          attachments: m.attachments,
          internal: m.isInternal,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    } else {
      throw ApiError.notFound('Ticket not found');
    }
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
