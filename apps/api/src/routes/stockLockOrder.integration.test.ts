import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * Review of Batch 1 (2026-10-30): orders lock a variant's row and then its
 * warehouse rows; the seller's stock screen (and admin receipts, counts and
 * moves) locked the warehouse rows first and the variant after. A seller
 * saving stock while buyers checked out the same items could deadlock — the
 * buyer's Pay or the seller's save answered 500.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let sellerToken: string;
const variantIds: string[] = [];
let ip = 0;

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    // Each request from its own address, as shoppers' are: one test address would hit the per-IP limit.
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-forwarded-for': `10.9.${(++ip >> 8) & 255}.${ip & 255}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: { orderId: string; id: string } } };
}

beforeAll(async () => {
  await seedFixture(prisma);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  sellerToken = signAccessToken({ sub: seller.userId, role: 'SELLER' });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, categoryId: category.id, title: 'Lock Order Book', slug: 'lock-order-book', description: 'Stock saved while it sells.', basePricePaise: 30_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  for (const v of ['lo-a', 'lo-b', 'lo-c']) {
    variantIds.push(
      (await prisma.productVariant.create({ data: { productId: product.id, optionValues: { set: v }, optionsKey: v, label: v, sku: `SKU-${v}`, pricePaise: 30_000, stock: 0 } })).id,
    );
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Stock set through the seller's screen, so it sits in a warehouse row.
  const set = await call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: variantIds.map((variantId) => ({ variantId, stock: 5000 })) });
  expect(set.status).toBe(200);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a seller saving stock while buyers check out the same items', () => {
  it('never deadlocks', async () => {
    const buyers = [];
    for (let n = 0; n < 6; n++) {
      const user = await prisma.user.create({ data: { phone: `93720${String(n).padStart(5, '0')}`, name: `Lock Order Buyer ${n}`, referralCode: `LOB-${n}` } });
      const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
      const address = await prisma.address.create({
        data: { userId: user.id, name: 'Lock Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
      });
      buyers.push({ token, addressId: address.id, order: n % 2 === 0 ? variantIds : [...variantIds].reverse() });
    }
    const statuses: number[] = [];
    for (let round = 0; round < 12; round++) {
      for (const b of buyers) for (const v of b.order) await call('POST', '/api/cart/items', b.token, { variantId: v, quantity: 1 });
      const replies = await Promise.all([
        ...buyers.map((b) => call('POST', '/api/orders/checkout', b.token, { addressId: b.addressId, paymentMethod: 'UPI' })),
        call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: variantIds.map((variantId) => ({ variantId, delta: 3 })) }),
        call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: [...variantIds].reverse().map((variantId) => ({ variantId, delta: 2 })) }),
        call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: variantIds.map((variantId) => ({ variantId, delta: -1 })) }),
        call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: [...variantIds].reverse().map((variantId) => ({ variantId, delta: -1 })) }),
      ]);
      statuses.push(...replies.map((r) => r.status));
      await Promise.all(
        buyers.map((b, i) => (replies[i]!.status === 200 ? call('POST', `/api/orders/${replies[i]!.json.data.orderId}/cancel`, b.token) : null)),
      );
    }
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });
});

// Round 6 (test runner on staging): completing a warehouse transfer moved its
// items one at a time in the transfer's order — 95 deadlocks under load, with
// checkouts, payments and cancels the casualties; and a seller's "+3" was
// added to the stock as it was read before the save, so a sale or another
// edit landing in between was overwritten.
describe('an admin completing warehouse transfers while buyers check out the same items', () => {
  it('never deadlocks', async () => {
    const admin = await prisma.user.create({ data: { phone: '9372099999', name: 'Lock Order Admin', role: Role.ADMIN, referralCode: 'LOB-A' } });
    const adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
    const main = await prisma.stockLocation.findFirstOrThrow({ where: { variantId: variantIds[0] }, select: { warehouseId: true } });
    const spare = await prisma.warehouse.create({ data: { code: 'LOCK-SPARE', name: 'Lock Order Spare', city: 'Pune', state: 'Maharashtra' } });
    const buyers = [];
    for (let n = 0; n < 6; n++) {
      const user = await prisma.user.create({ data: { phone: `93721${String(n).padStart(5, '0')}`, name: `Transfer Buyer ${n}`, referralCode: `LOT-${n}` } });
      const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
      const address = await prisma.address.create({
        data: { userId: user.id, name: 'Transfer Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
      });
      buyers.push({ token, addressId: address.id, order: n % 2 === 0 ? variantIds : [...variantIds].reverse() });
    }
    const statuses: number[] = [];
    for (let round = 0; round < 10; round++) {
      const [from, to] = round % 2 === 0 ? [main.warehouseId, spare.id] : [spare.id, main.warehouseId];
      const items = (round % 4 < 2 ? [...variantIds].reverse() : variantIds).map((variantId) => ({ variantId, quantity: 5 }));
      const created = [];
      for (const order of [items, [...items].reverse(), [items[1]!, items[0]!, items[2]!]]) {
        const t = await call('POST', '/api/admin/inventory/transfers', adminToken, { fromWarehouseId: from, toWarehouseId: to, items: order });
        expect(t.status).toBe(201);
        created.push(t.json.data.id);
      }
      for (const b of buyers) for (const v of b.order) await call('POST', '/api/cart/items', b.token, { variantId: v, quantity: 1 });
      const replies = await Promise.all([
        ...created.map((id) => call('PATCH', `/api/admin/inventory/transfers/${id}/status`, adminToken, { status: 'COMPLETED' })),
        ...buyers.map((b) => call('POST', '/api/orders/checkout', b.token, { addressId: b.addressId, paymentMethod: 'UPI' })),
      ]);
      statuses.push(...replies.map((r) => r.status));
      await Promise.all(
        buyers.map((b, i) => (replies[i + created.length]!.status === 200 ? call('POST', `/api/orders/${replies[i + created.length]!.json.data.orderId}/cancel`, b.token) : null)),
      );
    }
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });
});

describe('a seller adding stock in several saves at the same moment', () => {
  it('adds every one of them', async () => {
    const variantId = variantIds[2]!;
    const before = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    for (let burst = 0; burst < 5; burst++) {
      const replies = await Promise.all(
        Array.from({ length: 4 }, () => call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: [{ variantId, delta: 1 }] })),
      );
      expect(replies.every((r) => r.status === 200)).toBe(true);
    }
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(before + 20);
  });
});

// Round 8 (attacker): a variant made on the product form has its stock but no
// warehouse row, and warehouse actions re-derived the stock from the rows —
// receiving one unit on 50 left 1 (on staging, 50 became 3 after a failed
// payment had put 2 in a row). Production had 56 of 57 variants like that.
describe('a warehouse action on a variant whose stock has no warehouse row', () => {
  it('adds to the stock on sale instead of resetting it to the warehouse rows', async () => {
    const admin = await prisma.user.create({ data: { phone: '9372199999', name: 'Reconcile Admin', role: Role.ADMIN, referralCode: 'LOR-A' } });
    const adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'lock-order-book' } });
    const bare = await prisma.productVariant.create({ data: { productId: product.id, optionValues: { set: 'bare' }, optionsKey: 'bare', label: 'bare', sku: 'SKU-lo-bare', pricePaise: 30_000, stock: 50 } });
    const home = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true, isActive: true } });

    const received = await call('POST', '/api/admin/inventory/stock/receive', adminToken, { warehouseId: home.id, reason: 'Supplier delivery', lines: [{ variantId: bare.id, quantity: 1 }] });
    expect(received.status).toBeLessThan(300);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: bare.id } })).stock).toBe(51);
    const rows = await prisma.stockLocation.aggregate({ where: { variantId: bare.id }, _sum: { quantity: true } });
    expect(rows._sum.quantity).toBe(51);
  });
});

describe('more warehouse actions on a variant whose stock has no warehouse row (round 9)', () => {
  async function adminAndBare(tag: string) {
    const admin = await prisma.user.create({ data: { phone: `93722${tag.padStart(5, '0')}`, name: `Reconcile Admin ${tag}`, role: Role.ADMIN, referralCode: `LOR-${tag}` } });
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'lock-order-book' } });
    const bare = await prisma.productVariant.create({
      data: { productId: product.id, optionValues: { set: `bare-${tag}` }, optionsKey: `bare-${tag}`, label: `bare-${tag}`, sku: `SKU-LO-BARE-${tag}`, pricePaise: 30_000, stock: 25 },
    });
    return { token: signAccessToken({ sub: admin.id, role: 'ADMIN' }), bare };
  }
  const stockAndRows = async (id: string) => [
    (await prisma.productVariant.findUniqueOrThrow({ where: { id } })).stock,
    (await prisma.stockLocation.aggregate({ where: { variantId: id }, _sum: { quantity: true } }))._sum.quantity,
  ];

  it('an import that adds one unit into the default warehouse adds one (it reset 25 to 1)', async () => {
    const { token, bare } = await adminAndBare('11');
    const home = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true, isActive: true } });
    const r = await call('POST', '/api/admin/inventory/stock/import', token, { mode: 'ADD', reason: 'Supplier sheet', rows: [{ sku: bare.sku, warehouseCode: home.code, quantity: 1 }] });
    expect(r.status).toBe(200);
    expect(await stockAndRows(bare.id)).toEqual([26, 26]);
  });

  it('with no default warehouse yet (a fresh install), a receipt still adds to the stock on sale', async () => {
    const { token, bare } = await adminAndBare('12');
    const defaults = await prisma.warehouse.findMany({ where: { isDefault: true }, select: { id: true } });
    await prisma.warehouse.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const first = await prisma.warehouse.create({ data: { code: 'LOCK-FIRST', name: 'First Warehouse', city: 'Pune', state: 'Maharashtra' } });
    try {
      const r = await call('POST', '/api/admin/inventory/stock/receive', token, { warehouseId: first.id, reason: 'First delivery', lines: [{ variantId: bare.id, quantity: 1 }] });
      expect(r.status).toBeLessThan(300);
      expect(await stockAndRows(bare.id)).toEqual([26, 26]);
    } finally {
      await prisma.warehouse.updateMany({ where: { id: { in: defaults.map((d) => d.id) } }, data: { isDefault: true } });
    }
  });
});

describe('round 10 attack: adding into another warehouse, and the ceiling', () => {
  it('an import that adds into a non-default warehouse leaves the stock on sale in the default one', async () => {
    const admin = await prisma.user.create({ data: { phone: '9372300021', name: 'Placement Admin', role: Role.ADMIN, referralCode: 'LOR-21' } });
    const token = signAccessToken({ sub: admin.id, role: 'ADMIN' });
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'lock-order-book' } });
    const bare = await prisma.productVariant.create({ data: { productId: product.id, optionValues: { set: 'bare-21' }, optionsKey: 'bare-21', label: 'bare-21', sku: 'SKU-LO-BARE-21', pricePaise: 30_000, stock: 50 } });
    const home = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true, isActive: true } });
    const other = await prisma.warehouse.create({ data: { code: 'LOCK-OTHER', name: 'Other Warehouse', city: 'Pune', state: 'Maharashtra' } });
    const r = await call('POST', '/api/admin/inventory/stock/import', token, { mode: 'ADD', reason: 'Supplier sheet', rows: [{ sku: bare.sku, warehouseCode: other.code, quantity: 5 }] });
    expect(r.status).toBe(200);
    const rows = await prisma.stockLocation.findMany({ where: { variantId: bare.id } });
    expect(Object.fromEntries(rows.map((l) => [l.warehouseId === home.id ? 'home' : 'other', l.quantity]))).toEqual({ home: 50, other: 5 });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: bare.id } })).stock).toBe(55);
  });

  it('a receipt past 1,000,000 units is refused, and nothing changes', async () => {
    const admin = await prisma.user.create({ data: { phone: '9372300022', name: 'Ceiling Admin', role: Role.ADMIN, referralCode: 'LOR-22' } });
    const token = signAccessToken({ sub: admin.id, role: 'ADMIN' });
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'lock-order-book' } });
    const v = await prisma.productVariant.create({ data: { productId: product.id, optionValues: { set: 'big-22' }, optionsKey: 'big-22', label: 'big-22', sku: 'SKU-LO-BIG-22', pricePaise: 30_000, stock: 950_000 } });
    const home = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true, isActive: true } });
    const r = await call('POST', '/api/admin/inventory/stock/receive', token, { warehouseId: home.id, reason: 'Too much', lines: [{ variantId: v.id, quantity: 100_000 }] });
    expect(r.status).toBe(400);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: v.id } })).stock).toBe(950_000);
  });
});

describe('round 11 attack: the ceiling mid-file, and stock coming back at the ceiling', () => {
  it('an import with one row over the ceiling saves the others, lists that row, and answers what it did', async () => {
    const admin = await prisma.user.create({ data: { phone: '9372300031', name: 'Import Admin', role: Role.ADMIN, referralCode: 'LOR-31' } });
    const token = signAccessToken({ sub: admin.id, role: 'ADMIN' });
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'lock-order-book' } });
    const home = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true, isActive: true } });
    const mk = (tag: string, stock: number) =>
      prisma.productVariant.create({ data: { productId: product.id, optionValues: { set: tag }, optionsKey: tag, label: tag, sku: `SKU-LO-${tag}`, pricePaise: 30_000, stock } });
    const [b, big, c] = [await mk('imp-b', 50), await mk('imp-big', 50), await mk('imp-c', 50)];
    const r = await call('POST', '/api/admin/inventory/stock/import', token, {
      mode: 'ADD',
      reason: 'Supplier sheet',
      rows: [
        { sku: b.sku, warehouseCode: home.code, quantity: 10 },
        { sku: big.sku, warehouseCode: home.code, quantity: 1_000_000 },
        { sku: c.sku, warehouseCode: home.code, quantity: 10 },
      ],
    });
    expect(r.status).toBe(200);
    const result = r.json.data as unknown as { skipped: { row: number; reason: string }[] };
    expect(result.skipped.map((s) => s.row)).toEqual([2]);
    const stock = async (id: string) => (await prisma.productVariant.findUniqueOrThrow({ where: { id } })).stock;
    expect([await stock(b.id), await stock(big.id), await stock(c.id)]).toEqual([60, 50, 60]);
  });

  it('a failed payment gives its units back even with the product at the ceiling', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'lock-order-book' } });
    const v = await prisma.productVariant.create({ data: { productId: product.id, optionValues: { set: 'ceil-ret' }, optionsKey: 'ceil-ret', label: 'ceil-ret', sku: 'SKU-LO-CEIL-RET', pricePaise: 30_000, stock: 0 } });
    expect((await call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: [{ variantId: v.id, stock: 1_000_000 }] })).status).toBe(200);
    const user = await prisma.user.create({ data: { phone: '9372300032', name: 'Ceiling Buyer', referralCode: 'LOR-32' } });
    const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
    const address = await prisma.address.create({
      data: { userId: user.id, name: 'Ceiling Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
    });
    await call('POST', '/api/cart/items', token, { variantId: v.id, quantity: 2 });
    const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: 'UPI' });
    expect(co.status).toBe(200);
    expect((await call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: [{ variantId: v.id, delta: 2 }] })).status).toBe(200);
    const failed = await call('POST', '/api/payments/mock-pay', token, { orderId: co.json.data.orderId, outcome: 'failure' });
    expect(failed.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: co.json.data.orderId } })).status).toBe('CANCELLED');
  });
});

describe('round 12 attack: a product above the ceiling after units came back', () => {
  it('can still be counted down, and an addition never lowers it', async () => {
    const admin = await prisma.user.create({ data: { phone: '9372300041', name: 'Above Admin', role: Role.ADMIN, referralCode: 'LOR-41' } });
    const adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
    const product = await prisma.product.findFirstOrThrow({ where: { slug: 'lock-order-book' } });
    const v = await prisma.productVariant.create({ data: { productId: product.id, optionValues: { set: 'above' }, optionsKey: 'above', label: 'above', sku: 'SKU-LO-ABOVE', pricePaise: 30_000, stock: 0 } });
    await call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: [{ variantId: v.id, stock: 1_000_000 }] });
    const user = await prisma.user.create({ data: { phone: '9372300042', name: 'Above Buyer', referralCode: 'LOR-42' } });
    const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
    const address = await prisma.address.create({
      data: { userId: user.id, name: 'Above Buyer', phone: user.phone, line1: '1 Test Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
    });
    await call('POST', '/api/cart/items', token, { variantId: v.id, quantity: 2 });
    const co = await call('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: 'UPI' });
    await call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: [{ variantId: v.id, delta: 2 }] });
    await call('POST', '/api/payments/mock-pay', token, { orderId: co.json.data.orderId, outcome: 'failure' });
    const stock = async () => (await prisma.productVariant.findUniqueOrThrow({ where: { id: v.id } })).stock;
    expect(await stock()).toBe(1_000_002);

    // An addition leaves it where it is (it was lowered to the ceiling before).
    expect((await call('PATCH', '/api/seller/inventory/stock', sellerToken, { updates: [{ variantId: v.id, delta: 5 }] })).status).toBe(200);
    expect(await stock()).toBe(1_000_002);

    // A count that lowers it: allowed (it was refused for being above the ceiling).
    const row = await prisma.stockLocation.findFirstOrThrow({ where: { variantId: v.id, quantity: { gt: 0 } } });
    const counted = await call('POST', '/api/admin/inventory/stock/adjust', adminToken, { locationId: row.id, newQuantity: 999_000, reason: 'Shelf count' });
    expect(counted.status).toBeLessThan(300);
    expect(await stock()).toBe(999_000);
  });
});
