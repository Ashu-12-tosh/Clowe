import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { categoryRulesInputSchema, COURIER_DELIVERS_MESSAGE } from '@clowe/shared';
import { createApp } from '../app';
import { shippingProvider } from '../services/shipping';
import type { MockShippingProvider } from '../services/shipping/MockShippingProvider';
import { ShippingProviderError } from '../services/shipping/ShippingProvider';
import { applyTracking, refreshShipments } from '../services/shipping/tracking';
import { invalidateCategoryRules } from '../services/categoryRules';
import { signAccessToken } from '../utils/jwt';

/**
 * Running on Delhivery's live account (manual pickup): only Delhivery's scan
 * delivers a parcel (an admin can, with a reason on the audit log); a pickup
 * Delhivery missed goes back to the seller to ask again; a booking refused
 * over Clowe's wallet raises the alarm; after a failed delivery the parcel can
 * be re-addressed or sent back; Delhivery is told each line's HSN and GST
 * rate; the seller picks when Delhivery comes; the label carries the return
 * address.
 */

const prisma = new PrismaClient();
const mock = shippingProvider as unknown as MockShippingProvider;
let server: Server;
let base: string;
let sellerToken: string;
let adminToken: string;
let sellerId: string;
let sellerUserId: string;
let adminId: string;
let buyerId: string;
let hsnProductId: string;
let hsnVariantId: string;
let bareProductId: string;
let bareVariantId: string;
const categoryIds: string[] = [];
let seq = 0;
const orders: string[] = [];

/** A JSON reply, read loosely: any key, at any depth. */
interface Loose {
  [key: string]: Loose;
}
type Json = { data: Loose; error?: { code: string; message: string } };
async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

async function audited(action: string, entityId: string) {
  for (let i = 0; i < 20; i++) {
    const rows = await prisma.auditLog.findMany({ where: { action, entityId } });
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

/** A confirmed order of one line (with its packing video), booked with the (mock) courier. */
async function bookedOrder(opts: { bare?: boolean; book?: boolean } = {}) {
  seq += 1;
  const [productId, variantId] = opts.bare ? [bareProductId, bareVariantId] : [hsnProductId, hsnVariantId];
  const order = await prisma.order.create({
    data: {
      userId: buyerId, orderNumber: `CLW-2026-66${String(seq).padStart(4, '0')}`, status: 'CONFIRMED', subtotalPaise: 80_000, shippingPaise: 0, totalPaise: 80_000,
      shipName: 'Ops Buyer', shipPhone: '9196600002', shipLine1: '1 Old Street', shipLine2: 'Sector 4', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      payment: { create: { provider: 'mock', amountPaise: 80_000, status: 'PAID' } },
      items: { create: [{ productId, variantId, sellerId, title: 'Ops Tee', size: '', color: '', pricePaise: 80_000, quantity: 1, status: 'CONFIRMED', gstRatePercent: 5 }] },
    },
    include: { items: true },
  });
  orders.push(order.id);
  await prisma.orderPackingVideo.create({ data: { orderId: order.id, sellerId, fileRef: 'asset:test' } });
  const itemId = order.items[0]!.id;
  if (opts.book !== false) {
    const r = await call('POST', '/api/seller/orders/bulk', sellerToken, { itemIds: [itemId], action: 'assign' });
    expect(r.json.data, JSON.stringify(r.json)).toMatchObject({ updated: 1 });
  }
  return { orderId: order.id, itemId };
}

const parcelOf = (orderId: string) => prisma.shipment.findFirstOrThrow({ where: { orderId }, include: { items: true } });

/** As on the live account: the courier is Delhivery (the mock still answers). */
async function asDelhivery<T>(fn: () => Promise<T>): Promise<T> {
  Object.defineProperty(shippingProvider, 'name', { value: 'delhivery', configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(shippingProvider, 'name', { value: 'mock', configurable: true, writable: true });
  }
}

const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

beforeAll(async () => {
  const user = await prisma.user.create({ data: { phone: '9196600001', name: 'Ops Seller', role: Role.SELLER, referralCode: 'OPS-S' } });
  sellerUserId = user.id;
  sellerId = (
    await prisma.sellerProfile.create({
      data: {
        userId: user.id, shopName: 'Ops Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: '07ABCDE1234F1Z5',
        addressLine1: '5 Seller Road', city: 'Delhi', state: 'Delhi', pincode: '110053',
      },
    })
  ).id;
  sellerToken = signAccessToken({ sub: user.id, role: 'SELLER' });
  adminId = (await prisma.user.create({ data: { phone: '9196600009', name: 'Ops Admin', role: Role.ADMIN, referralCode: 'OPS-A' } })).id;
  adminToken = signAccessToken({ sub: adminId, role: 'ADMIN' });
  buyerId = (await prisma.user.create({ data: { phone: '9196600002', name: 'Ops Buyer', referralCode: 'OPS-B' } })).id;

  const withHsn = await prisma.category.create({ data: { name: 'Ops Tees', slug: 'ops-tees', isActive: true, hsnCode: '6109' } });
  const bare = await prisma.category.create({ data: { name: 'Ops Odds', slug: 'ops-odds', isActive: true } });
  categoryIds.push(withHsn.id, bare.id);
  invalidateCategoryRules();
  const product = (categoryId: string, slug: string) =>
    prisma.product.create({
      data: { sellerId, categoryId, title: 'Ops Tee', slug, description: 'For Delhivery ops tests.', basePricePaise: 80_000, status: ProductStatus.APPROVED, approvedAt: new Date(), weightGrams: 300 },
    });
  hsnProductId = (await product(withHsn.id, 'ops-tee')).id;
  bareProductId = (await product(bare.id, 'ops-odd')).id;
  const variant = (productId: string, sku: string) =>
    prisma.productVariant.create({ data: { productId, optionValues: {}, optionsKey: '', label: '', sku, pricePaise: 80_000, stock: 50 } });
  hsnVariantId = (await variant(hsnProductId, 'SKU-OPS-1')).id;
  bareVariantId = (await variant(bareProductId, 'SKU-OPS-2')).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  // A parcel sent back refunds its prepaid buyer: those rows go first.
  await prisma.refund.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.platformSetting.deleteMany({ where: { key: 'courier.walletAlert' } });
  await prisma.emailOutbox.deleteMany({ where: { kind: 'COURIER_WALLET_ALERT' } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('delivered by hand', () => {
  it("a seller can't mark a Delhivery parcel delivered; an admin can, only with a reason that goes on the audit log", async () => {
    const o = await bookedOrder();
    const p = await parcelOf(o.orderId);
    await prisma.shipment.update({ where: { id: p.id }, data: { provider: 'delhivery', status: 'IN_TRANSIT' } });
    await prisma.orderItem.update({ where: { id: o.itemId }, data: { status: 'SHIPPED', shippedAt: new Date() } });

    const seller = await call('PATCH', `/api/seller/orders/${o.itemId}/status`, sellerToken, { action: 'deliver' });
    expect(seller.status).toBe(400);
    expect(seller.json.error?.message).toBe(COURIER_DELIVERS_MESSAGE);
    const detail = await call('GET', `/api/seller/orders/${o.orderId}`, sellerToken);
    expect(detail.json.data.lines[0]).toMatchObject({ status: 'SHIPPED', canDeliver: false });

    const bare = await call('PATCH', `/api/admin/orders/${o.orderId}/status`, adminToken, { status: 'DELIVERED' });
    expect(bare.status).toBe(400);
    expect(bare.json.error?.code).toBe('COURIER_DELIVERY_OVERRIDE');
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.itemId } })).status).toBe('SHIPPED');

    const reason = 'Buyer confirmed receipt on a call; Delhivery scan missing';
    const ok = await call('PATCH', `/api/admin/orders/${o.orderId}/status`, adminToken, { status: 'DELIVERED', deliveryOverrideReason: reason });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.itemId } })).status).toBe('DELIVERED');
    const [row] = await audited('Marked delivered by hand', o.orderId);
    expect(row).toBeDefined();
    expect(row!.summary).toContain(reason);
    expect(row!.severity).toBe('HIGH');
  });

  it('on the mock courier the seller still marks it delivered', async () => {
    const o = await bookedOrder();
    await call('PATCH', `/api/seller/orders/${o.itemId}/status`, sellerToken, { action: 'ship' });
    const detail = await call('GET', `/api/seller/orders/${o.orderId}`, sellerToken);
    expect(detail.json.data.lines[0]).toMatchObject({ status: 'SHIPPED', canDeliver: true });
    expect((await call('PATCH', `/api/seller/orders/${o.itemId}/status`, sellerToken, { action: 'deliver' })).status).toBe(200);
  });
});

describe('a pickup Delhivery missed', () => {
  const notPicked = (awb: string, at: Date) =>
    applyTracking(
      {
        awbNumber: awb,
        status: 'CREATED',
        statusText: 'Shipment not received from client',
        chargedWeightGrams: null,
        scans: [{ at, statusType: 'UD', status: 'Not Picked', code: 'X-PNP', location: 'Najafgarh', instructions: 'Shipment not received from client' }],
      },
      'POLL',
    );

  it('goes back to "ready for pickup": the seller and admins are told once, and the next request is for the next pickup day', async () => {
    const o = await bookedOrder();
    await asDelhivery(() => call('PATCH', `/api/seller/orders/${o.itemId}/status`, sellerToken, { action: 'ship' }));
    const asked = await parcelOf(o.orderId);
    expect(asked.status).toBe('PICKUP_REQUESTED');
    const listed = await call('GET', `/api/seller/orders/${o.orderId}`, sellerToken);
    expect(listed.json.data.lines[0]).toMatchObject({ canShip: false, pickupScheduledFor: asked.pickupScheduledFor!.toISOString() });

    const at = new Date(Date.now() + 60_000);
    await notPicked(asked.awbNumber!, at);
    const failed = await parcelOf(o.orderId);
    expect(failed).toMatchObject({ status: 'CREATED', pickupRequestId: null, pickupScheduledFor: null, pickupFailures: 1 });
    expect(failed.pickupFailedAt?.toISOString()).toBe(at.toISOString());
    expect(failed.items[0]!.status).toBe('CONFIRMED');
    const told = () =>
      prisma.notification.findMany({ where: { OR: [{ userId: sellerUserId, type: 'SELLER_PICKUP_FAILED' }, { userId: adminId, type: 'PICKUP_FAILED' }], title: { contains: failed.awbNumber! } } });
    expect((await told()).map((n) => n.type).sort()).toEqual(['PICKUP_FAILED', 'SELLER_PICKUP_FAILED']);

    // The same scan again (webhook and poll both): nothing more.
    await notPicked(asked.awbNumber!, at);
    expect((await parcelOf(o.orderId)).pickupFailures).toBe(1);
    expect(await told()).toHaveLength(2);

    const again = await call('GET', `/api/seller/orders/${o.orderId}`, sellerToken);
    expect(again.json.data.lines[0]).toMatchObject({ canShip: true, pickupFailedAt: at.toISOString() });
    const admin = await call('GET', `/api/admin/shipments?filter=ATTENTION&q=${failed.awbNumber}`, adminToken);
    expect(admin.json.data.rows[0]).toMatchObject({ awbNumber: failed.awbNumber, pickupFailedAt: at.toISOString() });

    // Asking again: not today — Delhivery already failed to come today.
    const ask = vi.spyOn(shippingProvider, 'requestPickup');
    const r = await asDelhivery(() => call('PATCH', `/api/seller/orders/${o.itemId}/status`, sellerToken, { action: 'ship' }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(istDay(ask.mock.calls[0]![0].pickupAt)).not.toBe(istDay(new Date()));
    expect((await parcelOf(o.orderId)).status).toBe('PICKUP_REQUESTED');
    ask.mockRestore();
  });

  it('is our own cancellation when every line was cancelled: nothing changes, nobody is told', async () => {
    const o = await bookedOrder();
    await asDelhivery(() => call('PATCH', `/api/seller/orders/${o.itemId}/status`, sellerToken, { action: 'ship' }));
    const asked = await parcelOf(o.orderId);
    await prisma.orderItem.update({ where: { id: o.itemId }, data: { status: 'CANCELLED' } });
    await notPicked(asked.awbNumber!, new Date(Date.now() + 60_000));
    expect((await parcelOf(o.orderId)).status).toBe('PICKUP_REQUESTED');
    expect(await prisma.notification.count({ where: { type: { in: ['SELLER_PICKUP_FAILED', 'PICKUP_FAILED'] }, title: { contains: asked.awbNumber! } } })).toBe(0);
  });
});

describe("a booking refused over Clowe's Delhivery wallet", () => {
  it('raises a banner for admins, an in-app note and one email to support@ per six hours, until resolved', async () => {
    const book = vi
      .spyOn(shippingProvider, 'createShipment')
      .mockRejectedValue(new ShippingProviderError('Insufficient balance in wallet, please recharge', 'BOOKING_REFUSED'));
    const a = await bookedOrder({ book: false });
    const refused = await call('POST', '/api/seller/orders/bulk', sellerToken, { itemIds: [a.itemId], action: 'assign' });
    expect(refused.json.data.skipped[0].reason).toContain('Insufficient balance in wallet');

    const alert = await call('GET', '/api/admin/shipments/wallet-alert', adminToken);
    expect(alert.json.data).toMatchObject({ message: 'Insufficient balance in wallet, please recharge', count: 1 });
    expect(alert.json.data.context).toContain('Ops Shop');
    const emails = () => prisma.emailOutbox.findMany({ where: { kind: 'COURIER_WALLET_ALERT' } });
    expect((await emails()).map((e) => e.toEmail)).toEqual(['support@cloweshop.com']);
    const notes = () => prisma.notification.count({ where: { userId: adminId, type: 'COURIER_WALLET' } });
    expect(await notes()).toBe(1);

    // Refused again: counted, but no second email or note.
    const b = await bookedOrder({ book: false });
    await call('POST', '/api/seller/orders/bulk', sellerToken, { itemIds: [b.itemId], action: 'assign' });
    expect((await call('GET', '/api/admin/shipments/wallet-alert', adminToken)).json.data.count).toBe(2);
    expect(await emails()).toHaveLength(1);
    expect(await notes()).toBe(1);

    // Any other refusal is the seller's to fix, not the wallet.
    book.mockRejectedValue(new ShippingProviderError('Pincode is not serviceable', 'BOOKING_REFUSED'));
    await prisma.platformSetting.deleteMany({ where: { key: 'courier.walletAlert' } });
    const c = await bookedOrder({ book: false });
    await call('POST', '/api/seller/orders/bulk', sellerToken, { itemIds: [c.itemId], action: 'assign' });
    expect((await call('GET', '/api/admin/shipments/wallet-alert', adminToken)).json.data).toBeNull();
    book.mockRestore();

    // Recharged and resolved: on the audit log, banner gone.
    vi.spyOn(shippingProvider, 'createShipment').mockRejectedValueOnce(new ShippingProviderError('Wallet in finlock', 'BOOKING_REFUSED'));
    const d = await bookedOrder({ book: false });
    await call('POST', '/api/seller/orders/bulk', sellerToken, { itemIds: [d.itemId], action: 'assign' });
    expect((await call('GET', '/api/admin/shipments/wallet-alert', adminToken)).json.data.message).toBe('Wallet in finlock');
    expect((await call('DELETE', '/api/admin/shipments/wallet-alert', adminToken)).status).toBe(200);
    expect((await call('GET', '/api/admin/shipments/wallet-alert', adminToken)).json.data).toBeNull();
    expect(await audited('Delhivery wallet alert resolved', 'courier.walletAlert')).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe('after a failed delivery attempt', () => {
  async function failedDelivery() {
    const o = await bookedOrder();
    await call('PATCH', `/api/seller/orders/${o.itemId}/status`, sellerToken, { action: 'ship' });
    const p = await parcelOf(o.orderId);
    mock.simulate(p.awbNumber!, 'DELIVERY_FAILED');
    await refreshShipments([p.awbNumber!], 'POLL');
    expect((await parcelOf(o.orderId)).status).toBe('DELIVERY_FAILED');
    return { ...o, parcelId: p.id, awb: p.awbNumber! };
  }

  it('shows the attempt count and the address; the seller corrects the address (same PIN code) but never the phone', async () => {
    const o = await failedDelivery();
    const detail = await call('GET', `/api/seller/orders/${o.orderId}`, sellerToken);
    expect(detail.json.data.parcels[0]).toMatchObject({ deliveryAttempts: 1, deliverTo: { line1: '1 Old Street', line2: 'Sector 4', city: 'Pune', pincode: '411001' } });

    const phone = await call('POST', `/api/seller/orders/parcels/${o.parcelId}/ndr`, sellerToken, { action: 'EDIT_DETAILS', phone: '9876543210' });
    expect(phone.status).toBe(400);
    expect(phone.json.error?.code).toBe('NDR_PHONE_ADMIN_ONLY');
    expect((await call('POST', `/api/seller/orders/parcels/${o.parcelId}/ndr`, sellerToken, { action: 'EDIT_DETAILS' })).status).toBe(400);

    const ndr = vi.spyOn(shippingProvider, 'ndrAction');
    const ok = await call('POST', `/api/seller/orders/parcels/${o.parcelId}/ndr`, sellerToken, { action: 'EDIT_DETAILS', line1: '12 New Lane, Flat 3', line2: 'Near the park' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ndr.mock.calls[0]).toEqual([o.awb, { action: 'EDIT_DETAILS', deferTo: undefined, consignee: { line1: '12 New Lane, Flat 3, Near the park' } }]);
    ndr.mockRestore();
    expect((await parcelOf(o.orderId)).ndrAction).toBe('EDIT_DETAILS');
    expect(await prisma.notification.count({ where: { userId: buyerId, type: 'ORDER_NDR', title: { startsWith: 'Delivery details updated' } } })).toBeGreaterThan(0);
    expect(await audited('Delivery address corrected', o.parcelId)).toHaveLength(1);
  });

  it('an admin corrects the phone, or sends it back to the seller (Delhivery returns it to origin)', async () => {
    const o = await failedDelivery();
    const ndr = vi.spyOn(shippingProvider, 'ndrAction');
    const phone = await call('POST', `/api/admin/orders/shipments/${o.parcelId}/ndr`, adminToken, { action: 'EDIT_DETAILS', phone: '9876543210' });
    expect(phone.status, JSON.stringify(phone.json)).toBe(200);
    expect(ndr.mock.calls[0]![1]).toMatchObject({ action: 'EDIT_DETAILS', consignee: { phone: '9876543210' } });
    ndr.mockRestore();
    const [row] = await audited('Delivery details corrected', o.parcelId);
    expect(row!.metadata).toMatchObject({ phoneChanged: true });

    const back = await failedDelivery();
    const cancel = vi.spyOn(shippingProvider, 'cancelShipment');
    const r = await call('POST', `/api/admin/orders/shipments/${back.parcelId}/ndr`, adminToken, { action: 'RETURN_TO_SELLER' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(cancel).toHaveBeenCalledWith(back.awb);
    cancel.mockRestore();
    expect((await parcelOf(back.orderId)).ndrAction).toBe('RETURN_TO_SELLER');
    await refreshShipments([back.awb], 'POLL');
    expect((await parcelOf(back.orderId)).status).toBe('RTO_IN_TRANSIT');

    const list = await call('GET', `/api/admin/shipments?filter=ALL&q=${o.awb}`, adminToken);
    expect(list.json.data.rows[0]).toMatchObject({ deliveryAttempts: 1, deliverTo: { pincode: '411001' } });
  });

  it('a later day still has to be within six days', async () => {
    const o = await failedDelivery();
    const far = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    expect((await call('POST', `/api/admin/orders/shipments/${o.parcelId}/ndr`, adminToken, { action: 'DEFER_DELIVERY', deferTo: far })).status).toBe(400);
  });
});

describe("what Delhivery is told about the goods", () => {
  it("each line goes with its category's HSN code and the GST rate it was sold at; a category without one warns admins once a day", async () => {
    const book = vi.spyOn(shippingProvider, 'createShipment');
    await bookedOrder();
    expect(book.mock.calls[0]![0].products).toEqual([{ title: 'Ops Tee', quantity: 1, hsn: '6109', gstRatePercent: 5 }]);

    await bookedOrder({ bare: true });
    expect(book.mock.calls[1]![0].products[0]).toMatchObject({ hsn: null, gstRatePercent: 5 });
    const warned = () => prisma.notification.count({ where: { userId: adminId, type: 'CATEGORY_HSN_MISSING', linkHref: `/admin/categories?hsn=${categoryIds[1]}` } });
    expect(await warned()).toBe(1);
    await bookedOrder({ bare: true });
    expect(await warned()).toBe(1);
    book.mockRestore();

    // An HSN code is 4, 6 or 8 digits.
    expect(categoryRulesInputSchema.safeParse({ hsnCode: '61' }).success).toBe(false);
    expect(categoryRulesInputSchema.safeParse({ hsnCode: '61091000' }).success).toBe(true);
  });
});

describe('when Delhivery collects', () => {
  it("saves the seller's pickup time and days, and asks for a pickup on one of those days", async () => {
    const save = (body: Record<string, unknown>) =>
      call('PUT', '/api/seller/store/shipping', sellerToken, { pickupSameAsBusiness: true, codEnabled: true, ...body });
    expect((await save({ pickupDays: [] })).status).toBe(400);
    expect((await save({ pickupDays: [0] })).status).toBe(400);
    expect((await save({ pickupSlot: '21:00' })).status).toBe(400);
    expect((await save({ pickupSlot: '15:00', pickupDays: [4, 2] })).status).toBe(200);
    const settings = await call('GET', '/api/seller/store', sellerToken);
    expect(settings.json.data.settings).toMatchObject({ pickupSlot: '15:00', pickupDays: [2, 4] });

    const o = await bookedOrder();
    const ask = vi.spyOn(shippingProvider, 'requestPickup');
    await asDelhivery(() => call('PATCH', `/api/seller/orders/${o.itemId}/status`, sellerToken, { action: 'ship' }));
    const at: Date = ask.mock.calls[0]![0].pickupAt;
    const ist = new Date(at.getTime() + 330 * 60_000);
    expect([2, 4]).toContain(ist.getUTCDay());
    ask.mockRestore();

    // Leaving them out keeps them.
    expect((await save({})).status).toBe(200);
    expect((await call('GET', '/api/seller/store', sellerToken)).json.data.settings).toMatchObject({ pickupSlot: '15:00', pickupDays: [2, 4] });
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { pickupSlot: '11:00', pickupDays: [1, 2, 3, 4, 5, 6] } });
  });
});

describe('the shipping label', () => {
  it('carries the return address when the seller has a separate one', async () => {
    const o = await bookedOrder();
    const label = async () => (await call('GET', `/api/seller/orders/labels?ids=${o.itemId}`, sellerToken)).json.data as unknown as Loose[];
    expect((await label())[0]!.returnTo).toBeNull();
    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { returnAddressSameAsPickup: false, returnLine1: '12 Returns Lane', returnCity: 'Noida', returnState: 'Uttar Pradesh', returnPincode: '201301' },
    });
    try {
      expect((await label())[0]!.returnTo).toEqual({ line1: '12 Returns Lane', city: 'Noida', state: 'Uttar Pradesh', pincode: '201301' });
    } finally {
      await prisma.sellerProfile.update({ where: { id: sellerId }, data: { returnAddressSameAsPickup: true } });
    }
  });
});
