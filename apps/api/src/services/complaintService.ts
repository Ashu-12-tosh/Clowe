import { randomInt } from 'node:crypto';
import type { SupportChannel, TicketPriority } from '@prisma/client';
import { istDate, SLA_RESPONSE_HOURS, type ComplaintCategory } from '@clowe/shared';
import { prisma } from '../db';

// ---------------------------------------------------------------------------
// A customer complaint (support ticket), however it is raised: the support
// chat, a "stop my parcel" request after dispatch, and so on. One place, so
// every ticket gets its number, its timers and its notice to the shopper.
// ---------------------------------------------------------------------------

/** Human-readable unique complaint id, e.g. CMP-2026-48213. */
export async function generateComplaintId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `CMP-${istDate(new Date()).year}-${randomInt(0, 100000).toString().padStart(5, '0')}`;
    const exists = await prisma.complaint.findUnique({ where: { complaintId: candidate } });
    if (!exists) return candidate;
  }
  throw new Error('Could not generate a unique complaint id');
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
  const complaint = await prisma.complaint.create({
    data: {
      complaintId,
      userId: input.userId,
      orderId: input.orderId,
      category: input.category,
      subject: input.subject.slice(0, 90),
      description: input.description,
      priority: input.priority,
      channel: input.channel,
      slaDueAt: new Date(now.getTime() + SLA_RESPONSE_HOURS[input.priority] * 3600000),
      lastMessageAt: now,
      // The opening description is the first turn of the conversation.
      messages: { create: { authorId: input.userId, authorRole: 'CUSTOMER', body: input.description } },
    },
    include: { order: { select: { orderNumber: true } } },
  });
  await prisma.notification.create({
    data: {
      userId: input.userId,
      type: 'COMPLAINT_REGISTERED',
      title: 'Complaint registered 📢',
      body: `Your complaint ${complaintId} has been registered. Our team will get back to you.`,
    },
  });
  return complaint;
}
