import { randomInt } from 'node:crypto';
import type { SupportChannel, TicketPriority } from '@prisma/client';
import {
  complaintResolveDue,
  escalationTimers,
  istDate,
  nextSupportLevel,
  SELLER_RESPONSE_HOURS,
  SLA_RESPONSE_HOURS,
  SUPPORT_LEVEL_LABELS,
  type ComplaintCategory,
  type SupportLevel,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { sendToUserSafe } from './messaging';

// ---------------------------------------------------------------------------
// A customer complaint (support ticket), however it is raised: the support
// chat, a "stop my parcel" request after dispatch, and so on. One place, so
// every ticket gets its number (sent to the customer by SMS and e-mail,
// Grievance Policy 2.3), its timers (acknowledge in 24 hours; resolve within
// a month, or 24 hours for unlawful content, 4.2–4.3), and — for a complaint
// about the product — its seller, who answers within 24 hours (2.4).
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

/** Human-readable unique complaint id, e.g. CMP-2026-48213. */
export async function generateComplaintId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `CMP-${istDate(new Date()).year}-${randomInt(0, 100000).toString().padStart(5, '0')}`;
    const exists = await prisma.complaint.findUnique({ where: { complaintId: candidate } });
    if (!exists) return candidate;
  }
  throw new Error('Could not generate a unique complaint id');
}

/** Tell the customer their ticket number, in the app, by SMS and by e-mail. */
async function sendTicketNumber(userId: string, complaintId: string, title: string, body: string): Promise<void> {
  await prisma.notification.create({ data: { userId, type: 'COMPLAINT_REGISTERED', title, body, linkHref: '/account/help' } });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true, email: true } });
  if (!user) return;
  sendToUserSafe(userId, { channel: 'sms', to: `+91${user.phone}`, body: `Clowe: ${body}` }, { critical: true });
  if (user.email) sendToUserSafe(userId, { channel: 'email', to: user.email, subject: `${title} — ${complaintId}`, body }, { critical: true });
}

export async function raiseComplaint(input: {
  userId: string;
  orderId: string | null;
  category: ComplaintCategory;
  subject: string;
  description: string;
  priority: TicketPriority;
  channel: SupportChannel;
}) {
  const complaintId = await generateComplaintId();
  const now = new Date();
  const priority: TicketPriority = input.category === 'URGENT_CONTENT' ? 'URGENT' : input.priority;
  // A complaint about the product itself goes to its seller (one seller on the order).
  let sellerId: string | null = null;
  if (input.category === 'PRODUCT_QUALITY' && input.orderId) {
    const sellers = await prisma.orderItem.findMany({ where: { orderId: input.orderId }, distinct: ['sellerId'], select: { sellerId: true } });
    if (sellers.length === 1) sellerId = sellers[0]!.sellerId;
  }
  const complaint = await prisma.complaint.create({
    data: {
      complaintId,
      userId: input.userId,
      orderId: input.orderId,
      category: input.category,
      subject: input.subject.slice(0, 90),
      description: input.description,
      priority,
      channel: input.channel,
      slaDueAt: new Date(now.getTime() + SLA_RESPONSE_HOURS[priority] * HOUR_MS),
      resolveDueAt: complaintResolveDue(input.category, now),
      ...(sellerId ? { sellerId, sellerDueAt: new Date(now.getTime() + SELLER_RESPONSE_HOURS * HOUR_MS) } : {}),
      // Received now: every timer counts from this moment.
      createdAt: now,
      lastMessageAt: now,
      // The opening description is the first turn of the conversation.
      messages: { create: { authorId: input.userId, authorRole: 'CUSTOMER', body: input.description } },
    },
    include: { order: { select: { orderNumber: true } } },
  });
  await sendTicketNumber(
    input.userId,
    complaintId,
    'Complaint registered 📢',
    `Your complaint ${complaintId} has been registered. We reply within 24 hours; quote ${complaintId} to follow it up.`,
  );
  if (sellerId) await notifySellerOfComplaint(sellerId, complaint.id);
  if (priority === 'URGENT') {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type: 'COMPLAINT_URGENT',
        title: `Urgent complaint ${complaintId}`,
        body: input.category === 'URGENT_CONTENT' ? 'Unlawful or intimate content, or impersonation: act within 24 hours (Rule 3(2)(b)).' : input.subject,
        linkHref: '/admin/support/queue',
      })),
    });
  }
  return complaint;
}

async function notifySellerOfComplaint(sellerId: string, complaintId: string): Promise<void> {
  const [seller, c] = await Promise.all([
    prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { userId: true } }),
    prisma.complaint.findUniqueOrThrow({ where: { id: complaintId }, include: { order: { select: { orderNumber: true } } } }),
  ]);
  await prisma.notification.create({
    data: {
      userId: seller.userId,
      type: 'CUSTOMER_COMPLAINT',
      title: `Customer complaint ${c.complaintId}${c.order ? ` — ${c.order.orderNumber}` : ''}`,
      body: `A buyer reports a problem with your product. Reply within ${SELLER_RESPONSE_HOURS} hours from Customer complaints.`,
      linkHref: '/seller/customer-complaints',
    },
  });
}

/** An admin sends a complaint to a seller to answer (when the order has several, say). */
export async function routeComplaintToSeller(complaintId: string, sellerId: string): Promise<void> {
  const c = await prisma.complaint.findUnique({ where: { id: complaintId }, select: { orderId: true } });
  if (!c) throw ApiError.notFound('Ticket not found');
  if (c.orderId) {
    const onOrder = await prisma.orderItem.count({ where: { orderId: c.orderId, sellerId } });
    if (onOrder === 0) throw ApiError.badRequest('That seller has nothing on this order', 'NOT_THE_SELLER');
  }
  await prisma.complaint.update({
    where: { id: complaintId },
    data: { sellerId, sellerDueAt: new Date(Date.now() + SELLER_RESPONSE_HOURS * HOUR_MS), sellerRespondedAt: null },
  });
  await notifySellerOfComplaint(sellerId, complaintId);
}

/**
 * Up one level (3.1): Customer Support → Nodal Officer → Grievance Officer.
 * The new level has its own time to acknowledge; at the Grievance Officer it
 * is disposed of within 15 days (or sooner, if a month from receipt is
 * sooner). Raised by the customer, or by the desk.
 */
export async function escalateComplaint(input: { complaintId: string; by: 'CUSTOMER' | 'AGENT'; actorId: string; reason: string }) {
  const c = await prisma.complaint.findUnique({ where: { id: input.complaintId } });
  if (!c) throw ApiError.notFound('Complaint not found');
  if (input.by === 'CUSTOMER' && c.userId !== input.actorId) throw ApiError.notFound('Complaint not found');
  if (c.status === 'CLOSED') throw ApiError.badRequest('This complaint is closed', 'CLOSED');
  const level = nextSupportLevel(c.level);
  if (!level) throw ApiError.badRequest('This complaint is already with the Grievance Officer', 'TOP_LEVEL');
  const now = new Date();
  const timers = escalationTimers(level, now, c.resolveDueAt);
  await prisma.complaint.update({
    where: { id: c.id },
    data: {
      level,
      escalatedAt: now,
      status: 'OPEN',
      priority: c.priority === 'LOW' || c.priority === 'MEDIUM' ? 'HIGH' : c.priority,
      slaDueAt: timers.slaDueAt,
      resolveDueAt: timers.resolveDueAt,
      firstResponseAt: null,
      breachNotifiedAt: null,
      resolvedAt: null,
      lastMessageAt: now,
      messages: {
        create: {
          authorId: input.actorId,
          authorRole: input.by === 'CUSTOMER' ? 'CUSTOMER' : 'SYSTEM',
          body: `Escalated to ${SUPPORT_LEVEL_LABELS[level]}: ${input.reason}`,
        },
      },
    },
  });
  await sendTicketNumber(
    c.userId,
    c.complaintId,
    `Complaint ${c.complaintId} escalated`,
    `Your complaint ${c.complaintId} is now with the ${SUPPORT_LEVEL_LABELS[level].split('— ')[1]}. You will hear back within ${Math.round(
      (timers.slaDueAt.getTime() - now.getTime()) / HOUR_MS,
    )} hours.`,
  );
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await prisma.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      type: 'COMPLAINT_ESCALATED',
      title: `${c.complaintId} escalated — ${SUPPORT_LEVEL_LABELS[level]}`,
      body: input.reason.slice(0, 200),
      linkHref: '/admin/support/queue',
    })),
  });
  return { level };
}

/** The seller answers a complaint about their product; the customer sees it in the thread. */
export async function sellerReplyToComplaint(input: { complaintId: string; sellerId: string; authorId: string; body: string }) {
  const c = await prisma.complaint.findUnique({ where: { id: input.complaintId } });
  if (!c || c.sellerId !== input.sellerId) throw ApiError.notFound('Complaint not found');
  if (c.status === 'CLOSED') throw ApiError.badRequest('This complaint is closed', 'CLOSED');
  const now = new Date();
  await prisma.complaint.update({
    where: { id: c.id },
    data: {
      sellerRespondedAt: c.sellerRespondedAt ?? now,
      lastMessageAt: now,
      messages: { create: { authorId: input.authorId, authorRole: 'SELLER', body: input.body } },
    },
  });
  await prisma.notification.create({
    data: {
      userId: c.userId,
      type: 'COMPLAINT_REPLY',
      title: `The seller replied — ${c.complaintId}`,
      body: input.body.slice(0, 200),
      linkHref: '/account/help',
    },
  });
}

/** Tickets whose timers ran out: acknowledge, resolve, or the seller's 24 hours. Admins are told once. */
export async function sweepComplaintBreaches(now: Date = new Date()): Promise<number> {
  const breached = await prisma.complaint.findMany({
    where: {
      breachNotifiedAt: null,
      status: { notIn: ['RESOLVED', 'CLOSED'] },
      OR: [
        { slaDueAt: { lt: now }, firstResponseAt: null },
        { resolveDueAt: { lt: now } },
        { sellerDueAt: { lt: now }, sellerRespondedAt: null },
      ],
    },
    select: { id: true, complaintId: true, slaDueAt: true, firstResponseAt: true, resolveDueAt: true, sellerDueAt: true, sellerRespondedAt: true, level: true },
  });
  if (breached.length === 0) return 0;
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  for (const c of breached) {
    const what =
      c.resolveDueAt && c.resolveDueAt < now
        ? 'not resolved by its due date'
        : c.sellerDueAt && c.sellerDueAt < now && !c.sellerRespondedAt
          ? `the seller has not answered within ${SELLER_RESPONSE_HOURS} hours`
          : `not acknowledged in time (${SUPPORT_LEVEL_LABELS[c.level as SupportLevel] ?? c.level})`;
    await prisma.$transaction([
      prisma.complaint.update({ where: { id: c.id }, data: { breachNotifiedAt: now } }),
      prisma.notification.createMany({
        data: admins.map((a) => ({
          userId: a.id,
          type: 'COMPLAINT_OVERDUE',
          title: `Overdue: ${c.complaintId}`,
          body: `Complaint ${c.complaintId}: ${what}.`,
          linkHref: '/admin/support/queue',
        })),
      }),
    ]);
  }
  return breached.length;
}

export function startComplaintBreachSweep(): void {
  const run = () => {
    sweepComplaintBreaches()
      .then((n) => {
        if (n > 0) console.log(`[clowe-api] overdue complaints flagged: ${n}`);
      })
      .catch((err) => console.error('[clowe-api] complaint sweep failed:', err));
  };
  run();
  const timer = setInterval(run, 30 * 60 * 1000);
  timer.unref();
}
