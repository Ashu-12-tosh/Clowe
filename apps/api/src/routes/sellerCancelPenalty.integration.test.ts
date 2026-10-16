import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { setSetting } from '../services/settingsService';
import { cancelPenaltyKey, latePenaltyKey, postEntry } from '../services/sellerLedgerService';
import { signAccessToken } from '../utils/jwt';

/**
 * A seller who can't fulfil an order cancels their part of it: the buyer is
 * refunded for those lines (the whole order when nothing else is left) and
 * the stock comes back. Since the owner's Batch 2 there is no cancellation
 * penalty; one charged before that still shows, and can still be waived.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
const shops: Record<'A' | 'B', { sellerId: string; token: string; variantId: string }> = {} as never;
let adminToken: string;

interface Body {
  data: Record<string, unknown> & { orderId?: string };
  error?: { code: string; message: string };
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

/** A paid order (UPI) for one unit from each of `from`. */
async function paidOrder(from: Array<'A' | 'B'>) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `91970${String(seq).padStart(5, '0')}`, name: `Cancel Penalty Buyer ${seq}`, referralCode: `SCP-${seq}` },
  });
  const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
  const address = await prisma.address.create({
    data: { userId: user.id, name: 'Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
  });
  for (const s of from) expect((await call('POST', '/api/cart/items', token, { variantId: shops[s].variantId, quantity: 1 })).status).toBe(200);
  const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: 'UPI' });
  expect(co.status, JSON.stringify(co.json)).toBe(200);
  const orderId = co.json.data.orderId as string;
  expect((await call('POST', '/api/payments/mock-pay', token, { orderId, outcome: 'success' })).status).toBe(200);
  return { orderId, token, userId: user.id };
}

const penalties = (sellerId: string, orderId: string) =>
  prisma.sellerLedgerEntry.findMany({ where: { sellerId, orderId, type: 'SELLER_CANCEL_PENALTY' } });

beforeAll(async () => {
  await seedFixture(prisma);
  await setSetting('penaltyEnabled', true);
  await setSetting('sellerCancelPenaltyPaise', 15_000);
  await setSetting('sellerCancelPenaltyEffectiveFrom', new Date(Date.now() - 60_000).toISOString());
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const fixtureSeller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' }, include: { user: true } });
  const other = await prisma.user.create({ data: { phone: '9197099999', name: 'Second Shop', role: Role.SELLER, referralCode: 'SCP-B' } });
  const otherShop = await prisma.sellerProfile.create({
    data: { userId: other.id, shopName: 'Second Shop', slug: 'second-shop-scp', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5' },
  });
  for (const [key, seller, userId] of [['A', fixtureSeller, fixtureSeller.userId], ['B', otherShop, other.id]] as const) {
    const product = await prisma.product.create({
      data: { sellerId: seller.id, categoryId: category.id, title: `Cancel Penalty Book ${key}`, slug: `cancel-penalty-book-${key.toLowerCase()}`, description: 'For the seller cancellation tests.', basePricePaise: 50_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: `SKU-SCP-${key}`, pricePaise: 50_000, stock: 100 },
    });
    shops[key] = { sellerId: seller.id, token: signAccessToken({ sub: userId, role: 'SELLER' }), variantId: variant.id };
  }
  const admin = await prisma.user.create({ data: { phone: '9197000000', name: 'SCP Admin', role: Role.ADMIN, referralCode: 'SCP-ADM' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a seller cancelling a whole order', () => {
  it('cancels it, refunds what was paid, returns the stock, and charges no penalty', async () => {
    const { orderId } = await paidOrder(['A']);
    const paid = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    const stockBefore = (await prisma.productVariant.findUniqueOrThrow({ where: { id: shops.A.variantId } })).stock;

    const res = await call('POST', `/api/seller/orders/${orderId}/cancel`, shops.A.token, { reason: 'Out of stock in the warehouse' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data).toMatchObject({ cancelledLines: 1, penaltyPaise: 0, refund: { status: 'PROCESSED', amountPaise: paid.amountPaise } });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: shops.A.variantId } })).stock).toBe(stockBefore + 1);
    expect(await penalties(shops.A.sellerId, orderId)).toHaveLength(0);

    // A second try is refused.
    const again = await call('POST', `/api/seller/orders/${orderId}/cancel`, shops.A.token, { reason: 'Out of stock in the warehouse' });
    expect(again.status).toBe(400);
  });

  it('is refused once the items have shipped', async () => {
    const { orderId } = await paidOrder(['A']);
    await prisma.orderItem.updateMany({ where: { orderId }, data: { status: 'SHIPPED', shippedAt: new Date() } });
    const res = await call('POST', `/api/seller/orders/${orderId}/cancel`, shops.A.token, { reason: 'Changed my mind about it' });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe('NOTHING_TO_CANCEL');
    expect(await penalties(shops.A.sellerId, orderId)).toHaveLength(0);
  });

  it('is not possible on another seller’s order', async () => {
    const { orderId } = await paidOrder(['A']);
    const res = await call('POST', `/api/seller/orders/${orderId}/cancel`, shops.B.token, { reason: 'Not mine to cancel' });
    expect(res.status).toBe(404);
  });
});

describe('a seller cancelling their part of a shared order', () => {
  it('refunds only their lines, leaves the rest going, and charges no one', async () => {
    const { orderId } = await paidOrder(['A', 'B']);
    const lineA = await prisma.orderItem.findFirstOrThrow({ where: { orderId, sellerId: shops.A.sellerId } });

    const res = await call('POST', `/api/seller/orders/${orderId}/cancel`, shops.A.token, { reason: 'Damaged in storage' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data).toMatchObject({ cancelledLines: 1, penaltyPaise: 0, refund: { status: 'PROCESSED', amountPaise: lineA.pricePaise * lineA.quantity - lineA.promoDiscountPaise } });

    const lines = await prisma.orderItem.findMany({ where: { orderId }, orderBy: { sellerId: 'asc' } });
    expect(Object.fromEntries(lines.map((l) => [l.sellerId, l.status]))).toEqual({
      [shops.A.sellerId]: 'CANCELLED',
      [shops.B.sellerId]: 'CONFIRMED',
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).not.toBe('CANCELLED');
    expect(await penalties(shops.A.sellerId, orderId)).toHaveLength(0);
    expect(await penalties(shops.B.sellerId, orderId)).toHaveLength(0);
  });
});

describe('cancellations that are not the seller’s', () => {
  it('never charges the penalty when the buyer cancels', async () => {
    const { orderId, token } = await paidOrder(['A']);
    expect((await call('POST', `/api/orders/${orderId}/cancel`, token)).status).toBe(200);
    expect(await penalties(shops.A.sellerId, orderId)).toHaveLength(0);
  });

  it('never charges the penalty when an admin cancels', async () => {
    const { orderId } = await paidOrder(['A']);
    expect((await call('POST', `/api/admin/orders/${orderId}/cancel`, adminToken, { reason: 'Fraud check failed' })).status).toBe(200);
    expect(await penalties(shops.A.sellerId, orderId)).toHaveLength(0);
  });
});

describe('when the rule does not apply', () => {
  it('charges nothing on an order placed before it took effect', async () => {
    const { orderId } = await paidOrder(['A']);
    await setSetting('sellerCancelPenaltyEffectiveFrom', new Date(Date.now() + 60_000).toISOString());
    try {
      const res = await call('POST', `/api/seller/orders/${orderId}/cancel`, shops.A.token, { reason: 'Supplier let me down' });
      expect(res.status).toBe(200);
      expect(res.json.data.penaltyPaise).toBe(0);
      expect(await penalties(shops.A.sellerId, orderId)).toHaveLength(0);
    } finally {
      await setSetting('sellerCancelPenaltyEffectiveFrom', new Date(Date.now() - 60_000).toISOString());
    }
  });

  it('charges nothing while penalties are switched off', async () => {
    const { orderId } = await paidOrder(['A']);
    await setSetting('penaltyEnabled', false);
    try {
      const res = await call('POST', `/api/seller/orders/${orderId}/cancel`, shops.A.token, { reason: 'Supplier let me down' });
      expect(res.status).toBe(200);
      expect(res.json.data.penaltyPaise).toBe(0);
    } finally {
      await setSetting('penaltyEnabled', true);
    }
  });
});

describe('the penalties view and waivers', () => {
  it('lists both kinds, and a waiver forgives only the kind it was for', async () => {
    const { orderId } = await paidOrder(['A']);
    // The same order was also late (charged the way the sweep does), and was
    // cancelled with a penalty back when one was charged.
    await postEntry({ sellerId: shops.A.sellerId, type: 'LATE_DISPATCH_PENALTY', bucket: 'SETTLEMENT', amountPaise: -8_000, orderId, idempotencyKey: latePenaltyKey(orderId, shops.A.sellerId), note: 'Late' });
    await postEntry({ sellerId: shops.A.sellerId, type: 'SELLER_CANCEL_PENALTY', bucket: 'SETTLEMENT', amountPaise: -15_000, orderId, idempotencyKey: cancelPenaltyKey(orderId, shops.A.sellerId), note: 'Cancelled by seller: Could not source it' });

    const cancelEntry = (await penalties(shops.A.sellerId, orderId))[0]!;
    const waive = await call('POST', `/api/admin/sellers/${shops.A.sellerId}/ledger/${cancelEntry.id}/waive`, adminToken, { reason: 'Supplier recall, not their fault' });
    expect(waive.status, JSON.stringify(waive.json)).toBe(200);
    // Twice is refused.
    expect((await call('POST', `/api/admin/sellers/${shops.A.sellerId}/ledger/${cancelEntry.id}/waive`, adminToken, { reason: 'Supplier recall, not their fault' })).status).toBe(409);

    const view = await call('GET', '/api/seller/ledger/penalties', shops.A.token);
    const rows = (view.json.data.rows as Array<{ orderId: string; kind: string; waived: boolean; amountPaise: number }>).filter((r) => r.orderId === orderId);
    expect(rows.map((r) => [r.kind, r.amountPaise, r.waived]).sort()).toEqual([
      ['LATE_DISPATCH', 8_000, false],
      ['SELLER_CANCEL', 15_000, true],
    ]);
    // No cancellation penalty is charged any more.
    expect(view.json.data.cancelRule).toMatchObject({ enabled: false, penaltyPaise: 0 });

    // The admin ledger tells the two apart too.
    const ledger = await call('GET', `/api/admin/sellers/${shops.A.sellerId}/ledger?bucket=SETTLEMENT&pageSize=100`, adminToken);
    const kinds = (ledger.json.data.rows as Array<{ orderId?: string; type: string; penaltyKind: string | null; reference: { orderId: string | null } }>)
      .filter((r) => r.reference.orderId === orderId)
      .map((r) => `${r.type}:${r.penaltyKind}`)
      .sort();
    expect(kinds).toEqual(['LATE_DISPATCH_PENALTY:LATE_DISPATCH', 'PENALTY_WAIVER:SELLER_CANCEL', 'SELLER_CANCEL_PENALTY:SELLER_CANCEL']);
  });
});
