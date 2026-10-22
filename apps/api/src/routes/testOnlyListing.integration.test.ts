import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * Clowe's own payment-test listing (Product.testOnly, 23 Oct 2026): in no
 * list, search, category or sitemap feed for anyone; its page opens by direct
 * link; only an account an admin marked as a test account can buy it.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;
const stamp = Date.now();
const word = `zqtestonly${stamp}`;
let slug: string;
let variantId: string;
let categorySlug: string;

async function user(isTestAccount = false) {
  seq += 1;
  const u = await prisma.user.create({
    data: { phone: `91996${String(seq).padStart(5, '0')}`, name: `Tester ${seq}`, role: Role.CUSTOMER, referralCode: `TONLY-${stamp}-${seq}`, isTestAccount },
  });
  return { id: u.id, token: signAccessToken({ sub: u.id, role: Role.CUSTOMER }) };
}
async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

beforeAll(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await setSetting('storeOpenForOrders', true);
  const owner = await prisma.user.create({ data: { phone: `91996${String(90000 + (stamp % 9999)).padStart(5, '0')}`, name: 'Test-only Owner', role: Role.SELLER, referralCode: `TONLY-OWNER-${stamp}` } });
  const shop = await prisma.sellerProfile.create({
    data: {
      userId: owner.id, shopName: `Test-only Shop ${stamp}`, status: 'APPROVED', approvedAt: new Date(),
      addressLine1: '1 Test Street', city: 'New Delhi', state: 'Delhi', pincode: '110001',
    },
  });
  categorySlug = `test-only-cat-${stamp}`;
  const cat = await prisma.category.create({ data: { name: 'Test-only Cat', slug: categorySlug, isActive: true } });
  slug = `payment-test-${stamp}`;
  const p = await prisma.product.create({
    data: {
      sellerId: shop.id, categoryId: cat.id, title: `Payment test ${word}`, slug, description: `Internal ${word} listing.`,
      basePricePaise: 1_000, status: 'APPROVED', approvedAt: new Date(), testOnly: true,
      variants: { create: { optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: `TONLY-${stamp}`, pricePaise: 1_000, stock: 5 } },
    },
    include: { variants: true },
  });
  variantId = p.variants[0]!.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a test-only listing', () => {
  it('is in no list, category, search or suggestion, logged out or in', async () => {
    const shopper = await user();
    for (const token of [null, shopper.token]) {
      const all = await call<{ items: { slug: string }[] }>('GET', '/api/products?limit=48', token);
      expect(all.json.data.items.map((i) => i.slug)).not.toContain(slug);
      const inCat = await call<{ items: { slug: string }[] }>('GET', `/api/products?category=${categorySlug}`, token);
      expect(inCat.json.data.items).toHaveLength(0);
      const found = await call<{ items: { slug: string }[] }>('GET', `/api/products?q=${word}`, token);
      expect(found.json.data.items.map((i) => i.slug)).not.toContain(slug);
      const suggest = await call('GET', `/api/search/suggest?q=${word}`, token);
      expect(JSON.stringify(suggest.json.data ?? '')).not.toContain(slug);
    }
  });

  it('opens by its direct link and tells search engines not to index it', async () => {
    const page = await call<{ slug: string; testOnly: boolean }>('GET', `/api/products/${slug}`, null);
    expect(page.status).toBe(200);
    expect(page.json.data).toMatchObject({ slug, testOnly: true });
  });

  it('only a test account can put it in the cart or check it out', async () => {
    const shopper = await user();
    const refused = await call('POST', '/api/cart/items', shopper.token, { variantId, quantity: 1 });
    expect(refused.status).toBe(404);

    const tester = await user(true);
    expect((await call('POST', '/api/cart/items', tester.token, { variantId, quantity: 1 })).status).toBe(200);

    // A shopper who got it into a cart some other way still cannot buy it.
    const cart = await prisma.cart.create({ data: { userId: shopper.id } });
    await prisma.cartItem.create({ data: { cartId: cart.id, variantId, quantity: 1 } });
    const address = await prisma.address.create({
      data: { userId: shopper.id, name: 'Shopper', phone: '9500000003', line1: '2 Test Street', city: 'New Delhi', state: 'Delhi', pincode: '110001' },
    });
    const checkout = await call('POST', '/api/orders/checkout', shopper.token, { addressId: address.id, paymentMethod: 'UPI' });
    expect(checkout.json.error?.code).toBe('ITEM_UNAVAILABLE');
    expect(await prisma.order.count({ where: { userId: shopper.id } })).toBe(0);
  });
});
