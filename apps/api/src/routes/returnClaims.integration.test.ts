import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { PrismaClient, ProductStatus, Role, SellerStatus, type AssetPurpose } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MyReturnsResponse, OrderDetailView } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { useClaimRules, useEarlierReturnRules } from '../test/returnRules';
import { signAccessToken } from '../utils/jwt';

/**
 * The Return, Exchange and Refund Policy, as the code keeps it:
 *  - 1/2.1 claims only for a defective, damaged, wrong, incomplete,
 *    counterfeit or materially different item — no discretionary grounds;
 *  - 3.1/3.3 within 48 hours of delivery, or 7 days from noticing a hidden
 *    defect; 3.2 photos of the item, tag and packaging, and an unboxing video
 *    for damage, missing or wrong items;
 *  - 2.2/2.3 the buyer picks an identical exchange or a refund; no stock →
 *    refund; 2.4 a second defect after an exchange → refund only;
 *  - 4.3 quality check failed → the item goes back and the account is
 *    reviewed; 6.2/6.5 a refund starts at once, for the net amount paid;
 *  - 7.2 no reverse pickup → the buyer self-ships, reimbursed up to ₹100;
 *  - items delivered before the claims began keep the earlier rules.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
let sellerToken: string;
let sellerId: string;
let adminToken: string;
let variantId: string;
let productSlug: string;
const HOUR = 60 * 60 * 1000;

interface Body<T = Record<string, unknown>> {
  data: T;
  error?: { code: string; message: string; field?: string };
}
async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Body<T> };
}

async function asset(ownerId: string, purpose: AssetPurpose): Promise<string> {
  const a = await prisma.asset.create({
    data: { provider: 'local', key: `test/${randomBytes(8).toString('hex')}`, purpose, contentType: purpose === 'RETURN_VIDEO' ? 'video/mp4' : 'image/jpeg', bytes: 10, ownerId },
  });
  return `asset:${a.id}`;
}

/** A paid (or COD) order for the claim product, delivered `hoursAgo` hours ago. */
async function delivered(opts: { hoursAgo?: number; cod?: boolean; pincode?: string } = {}) {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91942${String(seq).padStart(5, '0')}`, name: `Claim Buyer ${seq}`, referralCode: `CLM-${seq}` } });
  const token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
  const address = await prisma.address.create({
    data: { userId: user.id, name: 'Claim Buyer', phone: user.phone, line1: '5 Garden Road', city: 'Pune', state: 'Maharashtra', pincode: opts.pincode ?? '411001', isDefault: true },
  });
  expect((await call('POST', '/api/cart/items', token, { variantId, quantity: 1 })).status).toBe(200);
  const co = await call<{ orderId: string }>('POST', '/api/orders/checkout', token, { addressId: address.id, paymentMethod: opts.cod ? 'COD' : 'UPI' });
  expect(co.status, JSON.stringify(co.json)).toBe(200);
  const orderId = co.json.data.orderId;
  if (!opts.cod) expect((await call('POST', '/api/payments/mock-pay', token, { orderId, outcome: 'success' })).status).toBe(200);
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
  await prisma.orderItem.update({
    where: { id: item.id },
    data: { status: 'DELIVERED', shippedAt: new Date(), deliveredAt: new Date(Date.now() - (opts.hoursAgo ?? 1) * HOUR) },
  });
  await prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
  return { userId: user.id, token, orderId, itemId: item.id };
}

/** Everything a claim needs, for this buyer. */
async function evidence(userId: string, withVideo = true) {
  return {
    photos: [await asset(userId, 'RETURN_PHOTO')],
    tagPhotos: [await asset(userId, 'RETURN_PHOTO')],
    packagingPhotos: [await asset(userId, 'RETURN_PHOTO')],
    ...(withVideo ? { unboxingVideo: await asset(userId, 'RETURN_VIDEO') } : {}),
  };
}

const BANK = { accountName: 'Claim Buyer', accountNumber: '123456789012', ifsc: 'HDFC0001234', ownAccount: true };

async function claim(b: { userId: string; token: string; itemId: string }, body: Record<string, unknown>) {
  return call<{ rmaNumber: string }>('POST', `/api/orders/items/${b.itemId}/return`, b.token, { ...(await evidence(b.userId)), ...body });
}

/** The courier brings the item back to the seller (its delivery scan on the reverse parcel). */
async function backWithSeller(returnId: string) {
  const ship = await prisma.shipment.findUnique({ where: { returnId } });
  if (ship) await prisma.shipment.update({ where: { id: ship.id }, data: { status: 'DELIVERED' } });
  else await prisma.return.update({ where: { id: returnId }, data: { pickedUpAt: new Date() } });
}

/** Approve, the item comes back, then check it at the seller's: passed or failed. */
async function approveAndCheck(itemId: string, passed: boolean, note?: string) {
  const r = await prisma.return.findUniqueOrThrow({ where: { orderItemId: itemId } });
  expect((await call('PATCH', `/api/seller/returns/${r.id}`, sellerToken, { action: 'approve' })).status).toBe(200);
  await backWithSeller(r.id);
  const checked = await call('PATCH', `/api/seller/returns/${r.id}`, sellerToken, { action: 'received', condition: passed ? 'OK' : 'DAMAGED', ...(note ? { note } : {}) });
  return { returnId: r.id, checked };
}

beforeAll(async () => {
  await seedFixture(prisma);
  await useClaimRules(prisma);
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const user = await prisma.user.create({ data: { phone: '9194100001', name: 'Claim Seller', role: Role.SELLER, referralCode: 'CLM-S' } });
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Claim Shop', slug: 'claim-shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '27ABCDE1234F1Z5',
        addressLine1: '9 Seller Street', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  sellerToken = signAccessToken({ sub: user.id, role: 'SELLER' });
  productSlug = 'claim-kurta';
  const product = await prisma.product.create({
    data: { sellerId, categoryId: category.id, title: 'Claim Kurta', slug: productSlug, description: 'For the claim tests.', basePricePaise: 120_000, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  variantId = (await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-CLM', pricePaise: 120_000, stock: 50 } })).id;
  const admin = await prisma.user.create({ data: { phone: '9194100002', name: 'Claim Admin', role: Role.ADMIN, referralCode: 'CLM-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('what can be claimed (1, 2.1)', () => {
  it('refuses discretionary grounds — a change of mind or a size preference', async () => {
    const b = await delivered();
    for (const reason of ['CHANGED_MIND', 'SIZE_FIT', 'OTHER']) {
      const res = await claim(b, { reason, remedy: 'REFUND' });
      expect(res.status, reason).toBe(400);
    }
  });

  it('shows the buyer the claim form, with the policy’s reasons and window', async () => {
    const b = await delivered();
    const detail = (await call<OrderDetailView>('GET', `/api/orders/${b.orderId}`, b.token)).json.data;
    const item = detail.items[0]!;
    expect(item.canReturn).toBe(true);
    expect(item.claim?.reasons).toEqual(['DEFECTIVE', 'DAMAGED', 'WRONG_ITEM', 'MISSING_PARTS', 'COUNTERFEIT', 'NOT_AS_DESCRIBED']);
    expect(new Date(item.claim!.windowEndsAt).getTime() - Date.now()).toBeLessThanOrEqual(48 * HOUR);
  });
});

describe('time limit and evidence (3)', () => {
  it('needs the item, tag and packaging photos, and the unboxing video for damage', async () => {
    const b = await delivered();
    const noVideo = await call('POST', `/api/orders/items/${b.itemId}/return`, b.token, { ...(await evidence(b.userId, false)), reason: 'DAMAGED', remedy: 'REFUND' });
    expect(noVideo.status).toBe(400);
    expect(JSON.stringify(noVideo.json)).toContain('unboxing video');
    const noTag = await call('POST', `/api/orders/items/${b.itemId}/return`, b.token, { ...(await evidence(b.userId)), tagPhotos: [], reason: 'DEFECTIVE', remedy: 'REFUND' });
    expect(noTag.status).toBe(400);
    // Someone else's photo cannot be attached.
    const other = await delivered();
    const stolen = await call('POST', `/api/orders/items/${b.itemId}/return`, b.token, { ...(await evidence(other.userId)), reason: 'DEFECTIVE', remedy: 'REFUND' });
    expect(stolen.status).not.toBe(200);
    // A defect needs no video.
    const ok = await call('POST', `/api/orders/items/${b.itemId}/return`, b.token, { ...(await evidence(b.userId, false)), reason: 'DEFECTIVE', remedy: 'REFUND' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const r = await prisma.return.findUniqueOrThrow({ where: { orderItemId: b.itemId } });
    expect(r).toMatchObject({ rules: 'CLAIM', remedy: 'REFUND', reasonCategory: 'DEFECTIVE' });
    expect(r.tagPhotos).toHaveLength(1);
    expect(r.packagingPhotos).toHaveLength(1);
  });

  it('closes after 48 hours, except for a hidden defect noticed within 7 days', async () => {
    const b = await delivered({ hoursAgo: 60 });
    const late = await claim(b, { reason: 'DAMAGED', remedy: 'REFUND' });
    expect(late.json.error?.code).toBe('CLAIM_WINDOW_CLOSED');
    const stale = await claim(b, { reason: 'DEFECTIVE', remedy: 'REFUND', latentNoticedAt: new Date(Date.now() - 9 * 24 * HOUR + 60 * HOUR).toISOString() });
    expect(stale.json.error?.code).toBe('CLAIM_WINDOW_CLOSED');
    const latent = await claim(b, { reason: 'DEFECTIVE', remedy: 'EXCHANGE', latentNoticedAt: new Date(Date.now() - 2 * 24 * HOUR).toISOString() });
    expect(latent.status, JSON.stringify(latent.json)).toBe(200);
  });

  it('keeps the earlier rules for an item delivered before the claims began', async () => {
    await useEarlierReturnRules(prisma);
    try {
      const b = await delivered();
      const res = await call('POST', `/api/orders/items/${b.itemId}/return`, b.token, { reason: 'SIZE_FIT', details: 'Too large' });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect((await prisma.return.findUniqueOrThrow({ where: { orderItemId: b.itemId } })).rules).toBe('LEGACY');
      expect((await call<OrderDetailView>('GET', `/api/orders/${b.orderId}`, b.token)).json.data.items[0]!.claim).toBeNull();
    } finally {
      await useClaimRules(prisma);
    }
  });
});

describe('after the quality check (2.2–2.4, 4.3, 6)', () => {
  // Pre-launch audit (2026-10-20), H3: "Item received back" was offered, and
  // a pass or fail accepted, while the courier had not yet collected the item —
  // a refund, or a send-back and an account review, for an item never returned.
  it('is not taken until the item is back with the seller', async () => {
    const b = await delivered();
    expect((await claim(b, { reason: 'DEFECTIVE', remedy: 'REFUND' })).status).toBe(200);
    const r = await prisma.return.findUniqueOrThrow({ where: { orderItemId: b.itemId } });
    expect((await call('PATCH', `/api/seller/returns/${r.id}`, sellerToken, { action: 'approve' })).status).toBe(200);
    const view = await call<{ itemBack: boolean; pickup: { status: string } | null }>('GET', `/api/seller/returns/${r.id}`, sellerToken);
    expect(view.json.data.itemBack).toBe(false);

    for (const body of [{ action: 'received', condition: 'OK' }, { action: 'received', condition: 'DAMAGED', note: 'Never came back yet' }]) {
      const early = await call('PATCH', `/api/seller/returns/${r.id}`, sellerToken, body);
      expect(early.json.error?.code).toBe('RETURN_NOT_RECEIVED');
    }
    const after = await prisma.return.findUniqueOrThrow({ where: { id: r.id }, include: { refund: true } });
    expect(after).toMatchObject({ status: 'APPROVED', qcPassed: null, sentBackOrderId: null });
    expect(after.refund).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).claimsReviewAt).toBeNull();

    await backWithSeller(r.id);
    expect((await call<{ itemBack: boolean }>('GET', `/api/seller/returns/${r.id}`, sellerToken)).json.data.itemBack).toBe(true);
    expect((await call('PATCH', `/api/seller/returns/${r.id}`, sellerToken, { action: 'received', condition: 'OK' })).status).toBe(200);
  });

  it('refunds the net amount paid at once when the refund passes the check', async () => {
    const b = await delivered();
    expect((await claim(b, { reason: 'WRONG_ITEM', remedy: 'REFUND' })).status).toBe(200);
    const { checked } = await approveAndCheck(b.itemId, true);
    expect(checked.status, JSON.stringify(checked.json)).toBe(200);
    const r = await prisma.return.findUniqueOrThrow({ where: { orderItemId: b.itemId }, include: { refund: true } });
    expect(r).toMatchObject({ status: 'REFUNDED', qcPassed: true });
    expect(r.refund).toMatchObject({ status: 'PROCESSED', amountPaise: 120_000 });
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: b.itemId } })).status).toBe('RETURNED');
  });

  it('sends an identical item free for an exchange, and the sale stands', async () => {
    const b = await delivered();
    expect((await claim(b, { reason: 'DEFECTIVE', remedy: 'EXCHANGE' })).status).toBe(200);
    const stock = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    await approveAndCheck(b.itemId, true);
    const r = await prisma.return.findUniqueOrThrow({ where: { orderItemId: b.itemId }, include: { refund: true } });
    expect(r.refund).toBeNull();
    expect(r.replacementOrderId).toBeTruthy();
    const rep = await prisma.order.findUniqueOrThrow({ where: { id: r.replacementOrderId! }, include: { items: true } });
    expect(rep).toMatchObject({ paymentMethod: 'REPLACEMENT', totalPaise: 0, status: 'CONFIRMED' });
    expect(rep.items[0]).toMatchObject({ variantId, replacementOfId: b.itemId });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(stock - 1);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: b.itemId } })).status).toBe('DELIVERED');
    const mine = (await call<MyReturnsResponse>('GET', '/api/me/returns', b.token)).json.data.items[0]!;
    expect(mine).toMatchObject({ rules: 'CLAIM', remedy: 'EXCHANGE', replacementOrder: { id: rep.id } });

    // The replacement, defective again: refund only (2.4), against what was paid on the original.
    const repItem = rep.items[0]!;
    await prisma.orderItem.update({ where: { id: repItem.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    const again = await call('POST', `/api/orders/items/${repItem.id}/return`, b.token, { ...(await evidence(b.userId)), reason: 'DEFECTIVE', remedy: 'EXCHANGE' });
    expect(again.json.error?.code).toBe('REFUND_ONLY');
    const detail = (await call<OrderDetailView>('GET', `/api/orders/${rep.id}`, b.token)).json.data;
    expect(detail.items[0]!.claim?.exchangeAllowed).toBe(false);
    expect((await call('POST', `/api/orders/items/${repItem.id}/return`, b.token, { ...(await evidence(b.userId)), reason: 'DEFECTIVE', remedy: 'REFUND' })).status).toBe(200);
    await approveAndCheck(repItem.id, true);
    const refund = await prisma.refund.findFirstOrThrow({ where: { return: { orderItemId: repItem.id } } });
    expect(refund).toMatchObject({ orderId: b.orderId, amountPaise: 120_000, status: 'PROCESSED' });
  });

  it('refunds instead when no identical item is in stock', async () => {
    const b = await delivered();
    expect((await claim(b, { reason: 'DEFECTIVE', remedy: 'EXCHANGE' })).status).toBe(200);
    const stock = (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    await prisma.productVariant.update({ where: { id: variantId }, data: { stock: 0 } });
    try {
      await approveAndCheck(b.itemId, true);
    } finally {
      await prisma.productVariant.update({ where: { id: variantId }, data: { stock } });
    }
    const r = await prisma.return.findUniqueOrThrow({ where: { orderItemId: b.itemId }, include: { refund: true } });
    expect(r.remedy).toBe('REFUND');
    expect(r.refund).toMatchObject({ amountPaise: 120_000 });
  });

  it('sends the item back and reviews the account when it fails the check, and says why', async () => {
    const b = await delivered();
    expect((await claim(b, { reason: 'NOT_AS_DESCRIBED', remedy: 'REFUND' })).status).toBe(200);
    const noReason = await approveAndCheck(b.itemId, false);
    expect(noReason.checked.status).toBe(400);
    const res = await call('PATCH', `/api/seller/returns/${noReason.returnId}`, sellerToken, { action: 'received', condition: 'DAMAGED', note: 'Worn and washed, tags removed' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const r = await prisma.return.findUniqueOrThrow({ where: { id: noReason.returnId }, include: { refund: true } });
    expect(r.refund).toBeNull();
    expect(r).toMatchObject({ qcPassed: false, qcNote: 'Worn and washed, tags removed' });
    const back = await prisma.order.findUniqueOrThrow({ where: { id: r.sentBackOrderId! }, include: { items: true } });
    expect(back).toMatchObject({ paymentMethod: 'REPLACEMENT', totalPaise: 0 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).claimsReviewNote).toContain('Worn and washed');
    const told = await prisma.notification.findFirstOrThrow({ where: { userId: b.userId, type: 'RETURN_REJECTED' } });
    expect(told.body).toContain('Worn and washed');
    const adminView = await call<{ claim: { buyerUnderReview: string | null } }>('GET', `/api/admin/returns/${r.id}`, adminToken);
    expect(adminView.json.data.claim.buyerUnderReview).toContain('failed quality check');
  });
});

describe('non-returnable items (5.1)', () => {
  it('take only a wrong, counterfeit or non-conforming claim', async () => {
    await prisma.product.update({ where: { slug: productSlug }, data: { nonReturnable: true } });
    try {
      const b = await delivered();
      expect((await claim(b, { reason: 'DEFECTIVE', remedy: 'REFUND' })).json.error?.code).toBe('NOT_RETURNABLE');
      expect((await call<OrderDetailView>('GET', `/api/orders/${b.orderId}`, b.token)).json.data.items[0]!.claim?.reasons).toEqual([
        'WRONG_ITEM',
        'COUNTERFEIT',
        'NOT_AS_DESCRIBED',
      ]);
      expect((await claim(b, { reason: 'COUNTERFEIT', remedy: 'REFUND' })).status).toBe(200);
    } finally {
      await prisma.product.update({ where: { slug: productSlug }, data: { nonReturnable: false } });
    }
  });
});

describe('self-ship where pickup is not serviceable (7.2)', () => {
  it('asks the buyer to send it, takes the receipt, and reimburses up to ₹100 at the seller’s cost', async () => {
    const b = await delivered({ pincode: '777777', cod: true });
    expect((await claim(b, { reason: 'WRONG_ITEM', remedy: 'REFUND', codRefundAccount: BANK })).status).toBe(200);
    const r = await prisma.return.findUniqueOrThrow({ where: { orderItemId: b.itemId } });
    expect((await call('PATCH', `/api/seller/returns/${r.id}`, sellerToken, { action: 'approve' })).status).toBe(200);
    expect((await prisma.return.findUniqueOrThrow({ where: { id: r.id } })).selfShip).toBe(true);
    expect(await prisma.shipment.count({ where: { returnId: r.id } })).toBe(0);
    const mine = (await call<MyReturnsResponse>('GET', '/api/me/returns', b.token)).json.data.items[0]!;
    expect(mine.selfShip?.sendTo).toMatchObject({ name: 'Claim Shop', pincode: '110053' });

    const receipt = await asset(b.userId, 'RETURN_PHOTO');
    expect((await call('POST', `/api/me/returns/${r.id}/self-ship`, b.token, { receipt, costPaise: 14_000 })).status).toBe(200);
    const tooMuch = await call('POST', `/api/admin/returns/${r.id}/self-ship/reimburse`, adminToken, { amountPaise: 14_000, reference: 'UPI123456' });
    expect(tooMuch.status).toBe(400);
    const paid = await call('POST', `/api/admin/returns/${r.id}/self-ship/reimburse`, adminToken, { amountPaise: 10_000, reference: 'UPI123456' });
    expect(paid.status, JSON.stringify(paid.json)).toBe(200);
    const charged = await prisma.sellerLedgerEntry.findFirstOrThrow({ where: { sellerId, type: 'RETURN_FREIGHT', orderItemId: b.itemId } });
    expect(charged.amountPaise).toBe(-10_000);
    expect((await call('POST', `/api/admin/returns/${r.id}/self-ship/reimburse`, adminToken, { amountPaise: 5_000, reference: 'UPI999999' })).json.error?.code).toBe('ALREADY_REIMBURSED');
  });
});
