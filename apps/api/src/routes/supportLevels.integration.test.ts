import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComplaintRow, SellerComplaintRow, SupportTicketDeskDetail } from '@clowe/shared';
import { createApp } from '../app';
import { messagingProvider } from '../services/messaging';
import { sweepComplaintBreaches } from '../services/complaintService';
import { signAccessToken } from '../utils/jwt';

/**
 * The Customer Support and Grievance Policy, as the code keeps it:
 *  - 2.3 every ticket has a number, sent to the customer (app, SMS, e-mail);
 *  - 2.2/3.1/4.2 acknowledged within 24 hours, resolved within a month;
 *  - 3.1/4.1 Support → Nodal Officer → Grievance Officer, the last
 *    acknowledging in 48 hours and disposing in 15 days;
 *  - 4.3 unlawful or intimate content: acted on within 24 hours;
 *  - 2.4 a complaint about the product goes to its seller, who answers in 24.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let sellerToken: string;
let sellerId: string;
let buyerToken: string;
let buyerId: string;
let orderId: string;
const HOUR = 60 * 60 * 1000;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { phone: '9195100000', name: 'Desk Admin', role: Role.ADMIN, referralCode: 'SUP-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const sellerUser = await prisma.user.create({ data: { phone: '9195100001', name: 'Desk Seller', role: Role.SELLER, referralCode: 'SUP-S' } });
  sellerId = (await prisma.sellerProfile.create({ data: { userId: sellerUser.id, shopName: 'Desk Shop', slug: 'desk-shop', status: SellerStatus.APPROVED, approvedAt: new Date() } })).id;
  sellerToken = signAccessToken({ sub: sellerUser.id, role: 'SELLER' });
  const buyer = await prisma.user.create({ data: { phone: '9195100002', name: 'Desk Buyer', email: 'desk.buyer@example.com', referralCode: 'SUP-B' } });
  buyerId = buyer.id;
  buyerToken = signAccessToken({ sub: buyer.id, role: 'CUSTOMER' });
  const category = await prisma.category.create({ data: { name: 'Desk Things', slug: 'desk-things', isActive: true } });
  const product = await prisma.product.create({
    data: { sellerId, categoryId: category.id, title: 'Desk Lamp', slug: 'desk-lamp', description: 'For support tests.', basePricePaise: 150_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-DESK', pricePaise: 150_000, stock: 5 } });
  orderId = (
    await prisma.order.create({
      data: {
        userId: buyerId, orderNumber: 'CLW-2026-951001', status: 'DELIVERED', subtotalPaise: 150_000, shippingPaise: 0, totalPaise: 150_000, paymentMethod: 'UPI',
        shipName: 'Desk Buyer', shipPhone: '9195100002', shipLine1: '1 Road', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
        items: { create: [{ productId: product.id, variantId: variant.id, sellerId, title: 'Desk Lamp', size: '', color: '', pricePaise: 150_000, quantity: 1, status: 'DELIVERED' }] },
      },
    })
  ).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a new ticket (2.2, 2.3, 4.2)', () => {
  it('gets a number sent by SMS and e-mail, a 24-hour reply target and a one-month resolve date', async () => {
    const sent = vi.spyOn(messagingProvider, 'send');
    const res = await call<ComplaintRow>('POST', '/api/complaints', buyerToken, { category: 'ORDER', description: 'The invoice shows the wrong address.' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const c = await prisma.complaint.findUniqueOrThrow({ where: { complaintId: res.json.data.complaintId } });
    expect(c.level).toBe('SUPPORT');
    expect(c.slaDueAt!.getTime() - c.createdAt.getTime()).toBeLessThanOrEqual(24 * HOUR);
    const month = new Date(c.createdAt);
    month.setMonth(month.getMonth() + 1);
    expect(c.resolveDueAt?.toISOString()).toBe(month.toISOString());
    await new Promise((r) => setTimeout(r, 50));
    const channels = sent.mock.calls.map(([m]) => m.channel);
    expect(channels).toEqual(expect.arrayContaining(['sms', 'email']));
    expect(sent.mock.calls.every(([m]) => m.body.includes(c.complaintId))).toBe(true);
    sent.mockRestore();
  });

  it('treats unlawful or intimate content as urgent: acted on within 24 hours', async () => {
    const res = await call<ComplaintRow>('POST', '/api/complaints', buyerToken, { category: 'URGENT_CONTENT', description: 'A morphed try-on image of me is being shared.' });
    const c = await prisma.complaint.findUniqueOrThrow({ where: { complaintId: res.json.data.complaintId } });
    expect(c.priority).toBe('URGENT');
    expect(c.resolveDueAt!.getTime() - c.createdAt.getTime()).toBe(24 * HOUR);
    expect(await prisma.notification.count({ where: { type: 'COMPLAINT_URGENT', body: { contains: 'Rule 3(2)(b)' } } })).toBeGreaterThan(0);
  });
});

describe('escalation (3.1, 4.1)', () => {
  it('goes Support → Nodal Officer → Grievance Officer, with each level’s timers', async () => {
    const res = await call<ComplaintRow>('POST', '/api/complaints', buyerToken, { category: 'PAYMENT', description: 'Charged twice for the same order.' });
    const id = res.json.data.id;
    const nodal = await call<{ level: string }>('POST', `/api/complaints/${id}/escalate`, buyerToken, { reason: 'No reply after two days' });
    expect(nodal.json.data.level).toBe('NODAL');
    let c = await prisma.complaint.findUniqueOrThrow({ where: { id } });
    expect(c.slaDueAt!.getTime() - c.escalatedAt!.getTime()).toBe(72 * HOUR);

    const grievance = await call<{ level: string }>('POST', `/api/admin/support-desk/${id}/escalate`, adminToken, { reason: 'Customer still not satisfied' });
    expect(grievance.json.data.level).toBe('GRIEVANCE');
    c = await prisma.complaint.findUniqueOrThrow({ where: { id } });
    expect(c.slaDueAt!.getTime() - c.escalatedAt!.getTime()).toBe(48 * HOUR);
    expect(c.resolveDueAt!.getTime() - c.escalatedAt!.getTime()).toBeLessThanOrEqual(15 * 24 * HOUR);
    expect((await call('POST', `/api/complaints/${id}/escalate`, buyerToken, { reason: 'Once more please' })).json.error?.code).toBe('TOP_LEVEL');
    const mine = (await call<ComplaintRow[]>('GET', '/api/complaints/me', buyerToken)).json.data.find((r) => r.id === id);
    expect(mine?.level).toBe('GRIEVANCE');
    // Someone else's complaint cannot be escalated.
    const other = await prisma.user.create({ data: { phone: '9195100009', name: 'Other', referralCode: 'SUP-O' } });
    expect((await call('POST', `/api/complaints/${id}/escalate`, signAccessToken({ sub: other.id, role: 'CUSTOMER' }), { reason: 'Not mine at all' })).status).toBe(404);
  });
});

describe('a complaint about the product (2.4)', () => {
  it('goes to its seller with 24 hours to answer; the buyer sees the reply', async () => {
    const res = await call<ComplaintRow>('POST', '/api/complaints', buyerToken, { category: 'PRODUCT_QUALITY', description: 'The lamp flickers from day one.', orderId });
    const c = await prisma.complaint.findUniqueOrThrow({ where: { complaintId: res.json.data.complaintId } });
    expect(c.sellerId).toBe(sellerId);
    expect(c.sellerDueAt!.getTime() - c.createdAt.getTime()).toBe(24 * HOUR);

    const list = (await call<SellerComplaintRow[]>('GET', '/api/seller/customer-complaints', sellerToken)).json.data;
    expect(list.map((r) => r.reference)).toContain(c.complaintId);
    const reply = await call('POST', `/api/seller/customer-complaints/${c.id}/reply`, sellerToken, { body: 'Sorry — we will exchange it.' });
    expect(reply.status, JSON.stringify(reply.json)).toBe(200);
    expect((await prisma.complaint.findUniqueOrThrow({ where: { id: c.id } })).sellerRespondedAt).not.toBeNull();
    const thread = (await call<{ messages: { authorName: string; body: string }[] }>('GET', `/api/complaints/${c.id}`, buyerToken)).json.data;
    expect(thread.messages.at(-1)).toMatchObject({ authorName: 'The seller', body: 'Sorry — we will exchange it.' });
    const desk = (await call<SupportTicketDeskDetail>('GET', `/api/admin/support-desk/${c.id}`, adminToken)).json.data;
    expect(desk.seller).toMatchObject({ id: sellerId, overdue: false });
    expect(desk.seller?.respondedAt).not.toBeNull();
    // Another seller cannot answer it.
    const otherUser = await prisma.user.create({ data: { phone: '9195100008', name: 'Other Seller', role: Role.SELLER, referralCode: 'SUP-OS' } });
    await prisma.sellerProfile.create({ data: { userId: otherUser.id, shopName: 'Other Desk Shop', slug: 'other-desk-shop', status: SellerStatus.APPROVED, approvedAt: new Date() } });
    expect((await call('POST', `/api/seller/customer-complaints/${c.id}/reply`, signAccessToken({ sub: otherUser.id, role: 'SELLER' }), { body: 'Hi' })).status).toBe(404);
  });
});

describe('timers that run out', () => {
  it('tell the admins once', async () => {
    const res = await call<ComplaintRow>('POST', '/api/complaints', buyerToken, { category: 'PRODUCT_QUALITY', description: 'Cracked base on arrival.', orderId });
    const c = await prisma.complaint.findUniqueOrThrow({ where: { complaintId: res.json.data.complaintId } });
    await prisma.complaint.update({ where: { id: c.id }, data: { sellerDueAt: new Date(Date.now() - HOUR) } });
    expect(await sweepComplaintBreaches()).toBeGreaterThan(0);
    const told = await prisma.notification.findMany({ where: { type: 'COMPLAINT_OVERDUE', body: { contains: c.complaintId } } });
    expect(told.length).toBeGreaterThan(0);
    expect(told[0]!.body).toContain('seller has not answered');
    await sweepComplaintBreaches();
    expect(await prisma.notification.count({ where: { type: 'COMPLAINT_OVERDUE', body: { contains: c.complaintId } } })).toBe(told.length);
  });
});
