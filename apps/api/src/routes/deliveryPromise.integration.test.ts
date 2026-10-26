import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { deliveryPromise, type CartDeliveryPromises, type OrderDetailView, type ProductDeliveryPromise } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { shippingProvider } from '../services/shipping';
import { clearCourierCache } from '../services/shipping/courierCache';
import { clearServiceabilityCache } from '../services/shipping/serviceability';
import { signAccessToken } from '../utils/jwt';

/**
 * The buyer's delivery date, one per seller (owner, 26 Oct): the seller's
 * dispatch promise from today (or the next working day after 14:00), plus
 * Delhivery's transit time from that seller's pickup pincode, plus a day —
 * on the product page, in the cart, at checkout, on the order and in its
 * message. Delhivery slow or down shows the zone range and never blocks
 * checkout; a parcel it can't deliver is refused by name.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let shopperToken: string;
let shopperId: string;
let productId: string;
let variantId: string;
let addressId: string;
let farAddressId: string;
const TITLE = 'Promise Test Book';

async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: T; error?: { code?: string; message?: string } };
  return { status: res.status, data: json.data as T, error: json.error };
}

/** The day a promise lands on, in India. */
const day = (iso: string | Date) => new Date(new Date(iso).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** Pretend to be the real courier for a moment, so the day's cache is used. */
async function asDelhivery<T>(fn: () => Promise<T>): Promise<T> {
  Object.defineProperty(shippingProvider, 'name', { value: 'delhivery', configurable: true, writable: true });
  clearCourierCache();
  clearServiceabilityCache();
  try {
    return await fn();
  } finally {
    Object.defineProperty(shippingProvider, 'name', { value: 'mock', configurable: true, writable: true });
    clearCourierCache();
    clearServiceabilityCache();
  }
}

beforeAll(async () => {
  await seedFixture(prisma);
  await setSetting('codMinOrderPaise', 0);
  // The fixture store picks up in Delhi (110053).
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id, categoryId: category.id, title: TITLE, slug: 'promise-test-book',
      description: 'A book.', basePricePaise: 60_000, status: ProductStatus.APPROVED, approvedAt: new Date(),
    },
  });
  productId = product.id;
  variantId = (
    await prisma.productVariant.create({
      data: { productId, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-PROMISE', pricePaise: 60_000, stock: 50 },
    })
  ).id;
  const shopper = await prisma.user.create({ data: { phone: '9155500002', name: 'Promise Shopper', referralCode: 'PRM-C' } });
  shopperId = shopper.id;
  shopperToken = signAccessToken({ sub: shopper.id, role: 'CUSTOMER' });
  addressId = (
    await prisma.address.create({
      data: { userId: shopper.id, name: 'Promise Shopper', phone: '9155500002', line1: '1 Test Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400050', isDefault: true },
    })
  ).id;
  farAddressId = (
    await prisma.address.create({
      data: { userId: shopper.id, name: 'Promise Shopper', phone: '9155500002', line1: '1 Nowhere', city: 'Nowhere', state: 'Maharashtra', pincode: '999999' },
    })
  ).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await call('POST', '/api/cart/items', shopperToken, { variantId, quantity: 1 });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await setSetting('codMinOrderPaise', DEFAULT_SETTINGS.codMinOrderPaise);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the delivery promise', () => {
  it('product page: dispatch promise + Delhivery TAT from the seller\'s pickup PIN + a day, free', async () => {
    const r = await call<ProductDeliveryPromise>('GET', `/api/delivery/promise?productId=${productId}&pincode=400050`, null);
    expect(r.status).toBe(200);
    // Delhi (110053) → Mumbai is the mock's zone D: 5 days; the fixture seller dispatches in 2.
    const expected = deliveryPromise({ now: new Date(), dispatchDays: 2, tatDays: 5, destinationPincode: '400050' });
    expect(r.data).toMatchObject({ pincode: '400050', deliverable: true, source: 'DELHIVERY_TAT', deliveryByLatest: null });
    expect(day(r.data.deliveryBy!)).toBe(day(expected.deliveryBy));
    expect(r.data.message).toMatch(/^Delivery by (Mon|Tue|Wed|Thu|Fri|Sat), \d{1,2} [A-Z][a-z]{2} · Free delivery$/);
  });

  it('product page: "Delivery not available at this PIN" where Delhivery does not deliver', async () => {
    const r = await call<ProductDeliveryPromise>('GET', `/api/delivery/promise?productId=${productId}&pincode=999999`, null);
    expect(r.data).toMatchObject({ deliverable: false, message: 'Delivery not available at this PIN', deliveryBy: null });
    expect((await call('GET', `/api/delivery/promise?productId=${productId}&pincode=12`, null)).status).toBe(400);
  });

  it('shows the zone range, and still sells, when Delhivery is down', async () => {
    const tat = vi.spyOn(shippingProvider, 'expectedTat').mockRejectedValue(new Error('Delhivery is having trouble (HTTP 503)'));
    const pin = vi.spyOn(shippingProvider, 'checkPincode').mockRejectedValue(new Error('down'));
    try {
      const r = await call<ProductDeliveryPromise>('GET', `/api/delivery/promise?productId=${productId}&pincode=400050`, null);
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ deliverable: true, source: 'ZONE' });
      expect(r.data.deliveryByLatest).not.toBeNull();
      expect(r.data.message).toMatch(/^Delivery by .+ – .+ · Free delivery$/);
    } finally {
      tat.mockRestore();
      pin.mockRestore();
    }
  });

  it('does not wait on a slow Delhivery: the zone range after a couple of seconds', async () => {
    const tat = vi.spyOn(shippingProvider, 'expectedTat').mockReturnValue(new Promise(() => {}));
    try {
      const started = Date.now();
      const r = await call<ProductDeliveryPromise>('GET', `/api/delivery/promise?productId=${productId}&pincode=400050`, null);
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(r.data).toMatchObject({ deliverable: true, source: 'ZONE' });
    } finally {
      tat.mockRestore();
    }
  });

  it('asks the real courier once a day per origin and destination', async () => {
    await asDelhivery(async () => {
      const tat = vi.spyOn(shippingProvider, 'expectedTat');
      const pin = vi.spyOn(shippingProvider, 'checkPincode');
      try {
        await call('GET', `/api/delivery/promise?productId=${productId}&pincode=400050`, null);
        const pinCalls = pin.mock.calls.length;
        await call('GET', `/api/delivery/promise?productId=${productId}&pincode=400050`, null);
        expect(tat).toHaveBeenCalledTimes(1);
        expect(tat).toHaveBeenCalledWith('110053', '400050', expect.any(Date));
        // The second look asks nothing (the mock's TAT checks the PIN itself, once).
        expect(pin.mock.calls.length).toBe(pinCalls);
        await call('GET', `/api/delivery/promise?productId=${productId}&pincode=110001`, null);
        expect(tat).toHaveBeenCalledTimes(2);
      } finally {
        tat.mockRestore();
        pin.mockRestore();
      }
    });
  });

  it('cart and checkout: one date per seller, and the lines that cannot come named', async () => {
    const ok = await call<CartDeliveryPromises>('GET', `/api/cart/delivery-promises?addressId=${addressId}`, shopperToken);
    expect(ok.data.sellers).toEqual([expect.objectContaining({ deliverable: true, source: 'DELHIVERY_TAT', priceLabel: 'Free delivery' })]);
    expect(ok.data.lines).toEqual([{ variantId, sellerId: ok.data.sellers[0]!.sellerId }]);
    expect(ok.data.blockedMessage).toBeNull();
    const byPin = await call<CartDeliveryPromises>('GET', '/api/cart/delivery-promises?pincode=400050', shopperToken);
    expect(byPin.data.sellers[0]!.label).toBe(ok.data.sellers[0]!.label);
    const far = await call<CartDeliveryPromises>('GET', `/api/cart/delivery-promises?addressId=${farAddressId}`, shopperToken);
    expect(far.data.sellers[0]).toMatchObject({ deliverable: false, label: 'Delivery not available at this PIN' });
    expect(far.data.blockedMessage).toContain(`"${TITLE}"`);
  });

  it('checkout refuses an item Delhivery can\'t bring from its seller, by name', async () => {
    // Delhivery serves the PIN, but not from this seller's pickup pincode.
    const tat = vi.spyOn(shippingProvider, 'expectedTat').mockResolvedValue({ serviceable: false, tatDays: null, expectedDeliveryDate: null });
    try {
      const r = await call('POST', '/api/orders/checkout', shopperToken, { addressId, paymentMethod: 'COD' });
      expect(r.status).toBe(400);
      expect(r.error).toMatchObject({ code: 'ITEM_NOT_DELIVERABLE' });
      expect(r.error?.message).toContain(`"${TITLE}" can't be delivered to 400050`);
    } finally {
      tat.mockRestore();
    }
  });

  it('keeps the promise and the freight estimate on the order; the order, its message and tracking show it', async () => {
    const r = await call<{ orderId: string }>('POST', '/api/orders/checkout', shopperToken, { addressId, paymentMethod: 'COD' });
    expect(r.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.data.orderId } });
    const kept = await prisma.orderSellerPromise.findFirstOrThrow({ where: { orderId: order.id } });
    expect(kept).toMatchObject({ source: 'DELHIVERY_TAT', tatDays: 5, dispatchDays: 2, originPincode: '110053', destinationPincode: '400050' });
    // The mock's flat test rate, GST included, for the parcel's slab.
    expect(kept.freightEstimatePaise).toBe(DEFAULT_SETTINGS.deliveryFeePaise);
    expect(kept.chargeableGrams).toBeGreaterThan(0);
    expect(order.etaTo?.getTime()).toBe(kept.deliveryBy.getTime());

    const note = await prisma.notification.findFirstOrThrow({ where: { userId: shopperId, type: 'ORDER_CONFIRMED' }, orderBy: { createdAt: 'desc' } });
    expect(note.body).toMatch(/Delivery by (Mon|Tue|Wed|Thu|Fri|Sat), \d{1,2} [A-Z][a-z]{2}\./);

    const view = await call<OrderDetailView>('GET', `/api/orders/${order.id}`, shopperToken);
    expect(view.data.sellerPromises).toEqual([expect.objectContaining({ label: expect.stringMatching(/^Delivery by /), deliveryBy: kept.deliveryBy.toISOString() })]);
    expect(view.data.items[0]!.deliveryPromise).toMatchObject({ deliveryBy: kept.deliveryBy.toISOString() });

    // Once booked, Delhivery's own date takes over in tracking.
    const promised = new Date(Date.now() + 3 * 86_400_000);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id, sellerId: item.sellerId, provider: 'mock', environment: 'mock', paymentType: 'COD', weightGrams: 500,
        awbNumber: 'PROMISE-AWB-1', status: 'CREATED', courierPromisedAt: promised, items: { connect: [{ id: item.id }] },
      },
    });
    const tracked = await call<OrderDetailView>('GET', `/api/orders/${order.id}`, shopperToken);
    expect(tracked.data.items[0]!.parcel).toMatchObject({ courierPromisedAt: promised.toISOString(), etaFrom: promised.toISOString(), etaTo: promised.toISOString() });
    await prisma.shipment.delete({ where: { id: shipment.id } });
  });
});
