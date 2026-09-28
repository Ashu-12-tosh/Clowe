import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * What a suspended seller can and cannot do.
 *
 * Suspension used to stop one thing: listing a new product. Everything else
 * kept working — a shop suspended for fraud could still request its money,
 * mark orders delivered, edit stock, and, worst of it, flip its own listings
 * back to visible and undo the suspension outright.
 *
 * The guard is keyed on the HTTP method, so reads stay open deliberately: a
 * seller who cannot see their orders, their money or the reason they were
 * stopped has no way to work out what to appeal. These tests pin both halves,
 * because a later pass that tightens the writes could quietly take the reads
 * and the support channel with it.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
let seq = 0;

beforeAll(async () => {
  await seedFixture(prisma);
  const category = await prisma.category.findFirst({ where: { isActive: true } });
  if (!category) throw new Error('fixture produced no active category');
  categoryId = category.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** A seller at a given status, with one product, one variant and one order item. */
async function makeSeller(status: SellerStatus) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `93000${String(seq).padStart(5, '0')}`,
      name: `Suspension Seller ${seq}`,
      role: Role.SELLER,
      referralCode: `SUS-S-${seq}`,
    },
  });
  const seller = await prisma.sellerProfile.create({
    data: {
      userId: user.id,
      shopName: `Suspension Shop ${seq}`,
      status,
      suspensionReason: status === SellerStatus.SUSPENDED ? 'Counterfeit listings' : null,
    },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId,
      title: `Suspension Product ${seq}`,
      slug: `suspension-product-${seq}`,
      description: 'Used by the seller suspension regression tests.',
      basePricePaise: 100_000,
      status: ProductStatus.APPROVED,
      isVisible: false, // what suspending a seller does to their listings
      approvedAt: new Date(),
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      optionValues: { size: 'M' },
      optionsKey: 'size:M',
      label: 'M',
      size: 'M',
      color: '',
      sku: `SKU-SUS-${seq}`,
      pricePaise: 100_000,
      stock: 5,
    },
  });
  return {
    token: signAccessToken({ sub: user.id, role: 'SELLER' }),
    sellerId: seller.id,
    product,
    variant,
  };
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: unknown;
    error?: { code: string };
  };
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------

describe('a suspended seller cannot write', () => {
  it('cannot request a payout', async () => {
    const s = await makeSeller(SellerStatus.SUSPENDED);
    const { status, json } = await call('POST', '/api/seller/payouts/request', s.token, {});
    expect(status).toBe(403);
    expect(json.error?.code).toBe('SELLER_BLOCKED');
  });

  it('cannot change an order status', async () => {
    const s = await makeSeller(SellerStatus.SUSPENDED);
    const { status, json } = await call(
      'PATCH',
      '/api/seller/orders/any-item-id/status',
      s.token,
      { action: 'SHIP' },
    );
    expect(status).toBe(403);
    expect(json.error?.code).toBe('SELLER_BLOCKED');
  });

  it('cannot edit stock', async () => {
    const s = await makeSeller(SellerStatus.SUSPENDED);
    const { status, json } = await call('PATCH', '/api/seller/inventory/stock', s.token, {
      updates: [{ variantId: s.variant.id, stock: 999 }],
    });
    expect(status).toBe(403);
    expect(json.error?.code).toBe('SELLER_BLOCKED');

    const after = await prisma.productVariant.findUnique({ where: { id: s.variant.id } });
    expect(after!.stock).toBe(5);
  });

  it('cannot put its listings back on the storefront', async () => {
    // The sharpest one. Suspending a seller hides their products; without this
    // the seller simply set isVisible back and the suspension meant nothing.
    const s = await makeSeller(SellerStatus.SUSPENDED);
    const { status, json } = await call(
      'PATCH',
      `/api/seller/products/${s.product.id}/visibility`,
      s.token,
      { isVisible: true },
    );
    expect(status).toBe(403);
    expect(json.error?.code).toBe('SELLER_BLOCKED');

    const after = await prisma.product.findUnique({ where: { id: s.product.id } });
    expect(after!.isVisible).toBe(false);
  });
});

describe('a suspended seller can still', () => {
  it('read their dashboard', async () => {
    const s = await makeSeller(SellerStatus.SUSPENDED);
    const { status } = await call('GET', '/api/seller/dashboard', s.token);
    expect(status).toBe(200);
  });

  it('open a support ticket, and see why they were suspended', async () => {
    // The support router is deliberately exempt. Suspending someone and
    // removing the way to contest it is not a suspension, it is a dead end —
    // and a later "tighten every seller router" pass would take this out
    // without noticing, which is why it is pinned here.
    const s = await makeSeller(SellerStatus.SUSPENDED);
    const ticket = await call('POST', '/api/seller/support/tickets', s.token, {
      category: 'ACCOUNT',
      subject: 'Appealing my suspension',
      body: 'I believe this suspension was a mistake and would like it reviewed.',
    });
    expect(ticket.status).toBe(200);

    const profile = await call('GET', '/api/seller/profile', s.token);
    expect(profile.status).toBe(200);
    expect((profile.json.data as { suspensionReason: string }).suspensionReason).toBe(
      'Counterfeit listings',
    );
  });
});

describe('a pending seller is not a suspended one', () => {
  it('can still complete their store profile on the way to approval', async () => {
    // The obvious fix was requireApprovedSeller everywhere. It would have shut
    // the door new sellers have to walk through: a PENDING seller fills in
    // their store profile and KYC precisely in order to become approved.
    const s = await makeSeller(SellerStatus.PENDING);
    const { status } = await call('PUT', '/api/seller/store/profile', s.token, {
      shopName: 'Pending Shop Renamed',
      description: 'Still getting set up.',
    });
    expect(status).toBe(200);

    const after = await prisma.sellerProfile.findUnique({ where: { id: s.sellerId } });
    expect(after!.shopName).toBe('Pending Shop Renamed');
  });
});
