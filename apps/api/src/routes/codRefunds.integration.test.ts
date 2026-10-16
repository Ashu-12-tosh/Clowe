import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { FIXTURE, seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { useEarlierReturnRules } from '../test/returnRules';

/**
 * Cash on Delivery return refunds (Refund Policy 6.4): the buyer gives a bank
 * account in their own name with the return; it is stored encrypted, shown to
 * an admin masked (in full only on request, logged), never to the seller.
 * The refund waits for an admin to pay it by bank transfer and record the
 * reference; the buyer is told, and every step is in the audit log.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
let adminToken: string;
let sellerToken: string;
const DAY = 86_400_000;
const ACCOUNT = { accountName: 'Cod Buyer', accountNumber: '50100123456789', ifsc: 'HDFC0001234', ownAccount: true };

beforeAll(async () => {
  // These items are under the earlier return rules (delivered before the claims began).
  await useEarlierReturnRules(prisma);
  await seedFixture(prisma);
  const admin = await prisma.user.create({ data: { phone: '9579999991', name: 'COD Admin', role: 'ADMIN', referralCode: 'CODR-ADM' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  const seller = await prisma.sellerProfile.findFirstOrThrow({ where: { slug: 'fixture-store' } });
  sellerToken = signAccessToken({ sub: seller.userId, role: 'SELLER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function call(method: string, urlPath: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { data?: unknown; error?: { code: string; field?: string } } };
}

/** A delivered line on an order paid `method`, with its (collected) payment. */
async function deliveredLine(method: 'COD' | 'UPI') {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `95700${String(seq).padStart(5, '0')}`, name: 'Cod Buyer', referralCode: `CODR-U-${seq}` },
  });
  const product = await prisma.product.findUniqueOrThrow({ where: { slug: FIXTURE.phoneWordedPlainly }, include: { variants: { take: 1 } } });
  const order = await prisma.order.create({
    data: {
      orderNumber: `CLW-CR-${String(seq).padStart(6, '0')}`,
      userId: user.id,
      shipName: 'Cod Buyer', shipPhone: user.phone, shipLine1: '1 Test Lane', shipCity: 'Mumbai', shipState: 'Maharashtra', shipPincode: '400001',
      status: 'DELIVERED', subtotalPaise: 300_000, totalPaise: 300_000, paymentMethod: method,
      payment: {
        create: {
          provider: method === 'COD' ? 'cod' : 'mock',
          providerPaymentId: method === 'COD' ? null : `pay_cr_${seq}`,
          amountPaise: 300_000, status: 'PAID', paidAt: new Date(),
        },
      },
      items: {
        create: {
          productId: product.id, variantId: product.variants[0]!.id, sellerId: product.sellerId, title: product.title,
          size: '', color: '', pricePaise: 300_000, quantity: 1, status: 'DELIVERED',
          deliveredAt: new Date(Date.now() - DAY), returnWindowDays: 5, returnable: true,
        },
      },
    },
    include: { items: true },
  });
  return { userId: user.id, token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }), orderId: order.id, itemId: order.items[0]!.id };
}

const askReturn = (line: { token: string; itemId: string }, extra: Record<string, unknown> = {}) =>
  call('POST', `/api/orders/items/${line.itemId}/return`, line.token, { reason: 'SIZE_FIT', details: 'Too small', ...extra });

async function auditRows(entityId: string, action: string) {
  for (let i = 0; i < 20; i++) {
    const rows = await prisma.auditLog.findMany({ where: { entityId, action } });
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

describe('starting a return on a Cash on Delivery order', () => {
  it('asks for the bank account, under its field', async () => {
    const line = await deliveredLine('COD');
    const res = await askReturn(line);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'COD_REFUND_ACCOUNT_REQUIRED', field: 'codRefundAccount.accountNumber' });
  });

  it('refuses a malformed account', async () => {
    const line = await deliveredLine('COD');
    expect((await askReturn(line, { codRefundAccount: { ...ACCOUNT, ifsc: 'BAD' } })).status).toBe(400);
  });

  it('stores it encrypted, keeping only the last four digits readable', async () => {
    const line = await deliveredLine('COD');
    expect((await askReturn(line, { codRefundAccount: ACCOUNT })).status).toBe(200);
    const stored = await prisma.codRefundAccount.findFirstOrThrow({ where: { return: { orderItemId: line.itemId } } });
    expect(stored).toMatchObject({ method: 'BANK', last4: '6789' });
    expect(stored.cipher).not.toContain(ACCOUNT.accountNumber);
    expect(stored.cipher).not.toContain(ACCOUNT.ifsc);
  });

  it('a prepaid order needs none, and keeps none', async () => {
    const line = await deliveredLine('UPI');
    expect((await askReturn(line, { codRefundAccount: ACCOUNT })).status).toBe(200);
    expect(await prisma.codRefundAccount.count({ where: { return: { orderItemId: line.itemId } } })).toBe(0);
  });
});

describe('the refund, end to end', () => {
  it('waits for an admin, who pays it by hand; the seller never sees the account', async () => {
    const line = await deliveredLine('COD');
    await askReturn(line, { codRefundAccount: ACCOUNT });
    const ret = await prisma.return.findUniqueOrThrow({ where: { orderItemId: line.itemId } });

    // The seller approves and receives it — and never sees the account.
    expect((await call('PATCH', `/api/seller/returns/${ret.id}`, sellerToken, { action: 'approve' })).status).toBe(200);
    const received = await call('PATCH', `/api/seller/returns/${ret.id}`, sellerToken, { action: 'received', condition: 'OK' });
    expect(received.status).toBe(200);
    for (const view of [received, await call('GET', '/api/seller/returns', sellerToken), await call('GET', `/api/seller/returns/${ret.id}`, sellerToken)]) {
      expect(view.text).not.toContain(ACCOUNT.accountNumber);
      expect(view.text).not.toContain('6789');
      expect(view.text).not.toContain(ACCOUNT.ifsc);
    }

    // Not sent to the gateway: pending, for an admin to pay.
    const refund = await prisma.refund.findFirstOrThrow({ where: { returnId: ret.id } });
    expect(refund).toMatchObject({ provider: 'manual-cod', status: 'PENDING' });
    const told = await prisma.notification.findFirstOrThrow({ where: { userId: line.userId, type: 'REFUND_INITIATED' } });
    expect(told.body).toMatch(/bank account/);

    // Sellers cannot reach the admin list.
    expect((await call('GET', '/api/admin/cod-refunds', sellerToken)).status).toBe(403);

    // The admin list shows it masked.
    const list = await call('GET', '/api/admin/cod-refunds', adminToken);
    const row = (list.json.data as { refundId: string; accountMasked: string }[]).find((r) => r.refundId === refund.id)!;
    expect(row.accountMasked).toBe('••••••••6789');
    expect(list.text).not.toContain(ACCOUNT.accountNumber);

    // Full details on request, and the request is logged.
    const shown = await call('POST', `/api/admin/cod-refunds/${refund.id}/reveal`, adminToken);
    expect(shown.json.data).toEqual({ accountName: 'Cod Buyer', accountNumber: ACCOUNT.accountNumber, ifsc: ACCOUNT.ifsc });
    const viewed = await auditRows(refund.id, 'COD refund account viewed');
    expect(viewed).toHaveLength(1);
    expect(JSON.stringify(viewed[0])).not.toContain(ACCOUNT.accountNumber);

    // Mark refunded: needs a reference; then paid, the buyer told, logged.
    expect((await call('POST', `/api/admin/cod-refunds/${refund.id}/mark-refunded`, adminToken, { reference: '1' })).status).toBe(400);
    const paid = await call('POST', `/api/admin/cod-refunds/${refund.id}/mark-refunded`, adminToken, { reference: 'UTR2026101600001' });
    expect(paid.status).toBe(200);
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({
      status: 'PROCESSED',
      providerRefundId: 'UTR2026101600001',
    });
    expect((await prisma.return.findUniqueOrThrow({ where: { id: ret.id } })).status).toBe('REFUNDED');
    const sent = await prisma.notification.findFirstOrThrow({ where: { userId: line.userId, type: 'REFUND_PROCESSED' } });
    expect(sent.body).toMatch(/ending 6789.*UTR2026101600001/);
    expect(await auditRows(refund.id, 'COD refund marked paid')).toHaveLength(1);

    // Once only; and it moves to the paid list.
    expect((await call('POST', `/api/admin/cod-refunds/${refund.id}/mark-refunded`, adminToken, { reference: 'UTR2026101600002' })).json.error?.code).toBe(
      'ALREADY_REFUNDED',
    );
    const paidList = await call('GET', '/api/admin/cod-refunds?status=PROCESSED', adminToken);
    expect((paidList.json.data as { refundId: string; reference: string }[]).find((r) => r.refundId === refund.id)?.reference).toBe('UTR2026101600001');
  });

  it('a prepaid return still refunds through the gateway at once', async () => {
    const line = await deliveredLine('UPI');
    await askReturn(line);
    const ret = await prisma.return.findUniqueOrThrow({ where: { orderItemId: line.itemId } });
    await call('PATCH', `/api/seller/returns/${ret.id}`, sellerToken, { action: 'approve' });
    await call('PATCH', `/api/seller/returns/${ret.id}`, sellerToken, { action: 'received', condition: 'OK' });
    const refund = await prisma.refund.findFirstOrThrow({ where: { returnId: ret.id } });
    expect(refund.provider).not.toBe('manual-cod');
    expect(refund.status).toBe('PROCESSED');
  });
});
