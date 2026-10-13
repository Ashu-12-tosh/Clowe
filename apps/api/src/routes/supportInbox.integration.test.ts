import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import type { InboxPage, InboxThread } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * The admin support inbox: seller tickets and customer complaints in one
 * list, newest activity first, with unread counts that clear when an admin
 * opens the conversation and come back when the other side writes again.
 * Seller tickets used to be visible to no admin screen at all.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let sellerUserId: string;
let ticketId: string;
let complaintId: string;

async function get<T>(path: string, token = adminToken) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, data: ((await res.json()) as { data: T }).data };
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { phone: '9199100000', name: 'Inbox Admin', role: Role.ADMIN, referralCode: 'INB-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const sellerUser = await prisma.user.create({ data: { phone: '9199100001', name: 'Inbox Seller', role: Role.SELLER, referralCode: 'INB-S' } });
  sellerUserId = sellerUser.id;
  const seller = await prisma.sellerProfile.create({ data: { userId: sellerUser.id, shopName: 'Inbox Test Shop', status: SellerStatus.APPROVED } });
  const customer = await prisma.user.create({ data: { phone: '9199100002', name: 'Inbox Customer', referralCode: 'INB-C' } });

  const old = new Date(Date.now() - 60 * 60_000);
  const ticket = await prisma.supportTicket.create({
    data: {
      reference: 'TK-990001',
      sellerId: seller.id,
      category: 'PAYOUTS',
      subject: 'Payout missing',
      lastMessageAt: old,
      messages: { create: [{ authorId: sellerUser.id, authorRole: 'SELLER', body: 'My payout did not arrive this week.', createdAt: old }] },
    },
  });
  ticketId = ticket.id;
  const complaint = await prisma.complaint.create({
    data: {
      complaintId: 'CMP-2026-99001',
      userId: customer.id,
      category: 'DELIVERY',
      subject: 'Parcel late',
      description: 'Where is my parcel?',
      messages: {
        create: [
          { authorId: customer.id, authorRole: 'CUSTOMER', body: 'Where is my parcel?' },
          { authorId: customer.id, authorRole: 'CUSTOMER', body: 'Any update please?' },
        ],
      },
    },
  });
  complaintId = complaint.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the support inbox', () => {
  it('lists seller tickets and customer complaints together, newest first, with unread counts', async () => {
    const { status, data } = await get<InboxPage>('/api/admin/support-inbox?status=ALL&q=Inbox');
    expect(status).toBe(200);
    expect(data.rows.map((r) => [r.kind, r.reference, r.name, r.unread, r.lastFrom])).toEqual([
      ['CUSTOMER', 'CMP-2026-99001', 'Inbox Customer', 2, 'THEM'],
      ['SELLER', 'TK-990001', 'Inbox Test Shop', 1, 'THEM'],
    ]);
    expect(data.unreadTotal).toBe(3);
  });

  it('filters by kind, status and search', async () => {
    expect((await get<InboxPage>('/api/admin/support-inbox?status=ALL&kind=SELLER&q=Inbox')).data.rows.map((r) => r.reference)).toEqual(['TK-990001']);
    expect((await get<InboxPage>('/api/admin/support-inbox?status=RESOLVED&q=Inbox')).data.rows).toEqual([]);
    expect((await get<InboxPage>('/api/admin/support-inbox?status=ALL&q=TK-990001')).data.rows.map((r) => r.reference)).toEqual(['TK-990001']);
  });

  it('opening a conversation shows it and clears its unread count', async () => {
    const { status, data } = await get<InboxThread>(`/api/admin/support-inbox/seller/${ticketId}`);
    expect(status).toBe(200);
    expect(data.row).toMatchObject({ kind: 'SELLER', name: 'Inbox Test Shop', subject: 'Payout missing', status: 'OPEN' });
    expect(data.messages.map((m) => [m.from, m.body])).toEqual([['THEM', 'My payout did not arrive this week.']]);
    const after = await get<InboxPage>('/api/admin/support-inbox?status=ALL&kind=SELLER&q=Inbox');
    expect(after.data.rows[0]!.unread).toBe(0);
  });

  it('counts a new message from the other side again, and an admin reply moves the conversation', async () => {
    await prisma.supportTicketMessage.create({ data: { ticketId, authorId: sellerUserId, authorRole: 'SELLER', body: 'Still waiting.' } });
    expect((await get<InboxPage>('/api/admin/support-inbox?status=ALL&kind=SELLER&q=Inbox')).data.rows[0]!.unread).toBe(1);

    const reply = await fetch(`${base}/api/admin/support/${ticketId}/reply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Looking into it now.', attachments: ['https://example.com/proof.png'] }),
    });
    expect(reply.status).toBe(200);
    const thread = (await get<InboxThread>(`/api/admin/support-inbox/seller/${ticketId}`)).data;
    expect(thread.messages.at(-1)).toMatchObject({ from: 'US', body: 'Looking into it now.', attachments: ['https://example.com/proof.png'] });
    expect(thread.row.status).toBe('IN_PROGRESS');
    const list = (await get<InboxPage>('/api/admin/support-inbox?status=ALL&q=Inbox')).data.rows;
    expect(list[0]).toMatchObject({ reference: 'TK-990001', lastFrom: 'US', unread: 0 });
  });

  it('is for admins only', async () => {
    const sellerToken = signAccessToken({ sub: sellerUserId, role: 'SELLER' });
    expect((await get('/api/admin/support-inbox', sellerToken)).status).toBe(403);
    expect((await get(`/api/admin/support-inbox/customer/${complaintId}`, sellerToken)).status).toBe(403);
  });
});
