import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * Variant ownership on PUT /api/seller/products/:id.
 *
 * This file exists because of a real hole, not a hypothetical one. The handler
 * checked that the *product* belonged to the caller and then updated variants
 * by an id taken straight from the request body:
 *
 *     prisma.productVariant.update({ where: { id: v.id! }, ... })
 *
 * Every variant id is public — the storefront returns them on the product page
 * so the cart can reference a size — so any approved seller could read a
 * rival's ids off the shop front and send them in a request against their own
 * product, rewriting that rival's live price, stock and SKU. Owning a product
 * is not owning a variant, and these tests are what say so.
 *
 * The assertions deliberately check the database, not just the status code. A
 * response can be made to look right while the write still lands.
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

/** An approved seller with one product and one variant, isolated per test. */
async function makeSellerWithProduct(tag: string) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `92000${String(seq).padStart(5, '0')}`,
      name: `Variant Seller ${seq}`,
      role: Role.SELLER,
      referralCode: `VAR-S-${seq}`,
    },
  });
  const seller = await prisma.sellerProfile.create({
    data: {
      userId: user.id,
      shopName: `Variant Shop ${seq}`,
      status: SellerStatus.APPROVED,
    },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId,
      title: `Variant Test Product ${tag} ${seq}`,
      slug: `variant-test-${tag}-${seq}`,
      description: 'A product used by the variant ownership regression tests.',
      basePricePaise: 100_000,
      status: ProductStatus.APPROVED,
      isVisible: true,
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
      sku: `SKU-VAR-${tag}-${seq}`,
      pricePaise: 100_000,
      stock: 25,
    },
  });
  return {
    token: signAccessToken({ sub: user.id, role: 'SELLER' }),
    sellerId: seller.id,
    product,
    variant,
  };
}

/**
 * A minimal but valid DRAFT save. DRAFT is used on purpose: it skips the
 * submit-time checks (packing video, required attributes, image count) so a
 * failure here can only be about variant ownership.
 */
function putBody(variants: Array<Record<string, unknown>>) {
  return {
    title: 'Variant Ownership Edit',
    categoryId,
    description: 'Edited by the variant ownership regression test.',
    imageUrls: [],
    variants,
    mode: 'DRAFT',
  };
}

async function putProduct(token: string, productId: string, variants: Array<Record<string, unknown>>) {
  const res = await fetch(`${base}/api/seller/products/${productId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(putBody(variants)),
  });
  return { status: res.status, json: (await res.json()) as { error?: { code: string } } };
}

// ---------------------------------------------------------------------------

describe('PUT /api/seller/products/:id — variant ownership', () => {
  it('refuses a variant belonging to another seller, and does not touch it', async () => {
    const attacker = await makeSellerWithProduct('attacker');
    const victim = await makeSellerWithProduct('victim');

    const { status, json } = await putProduct(attacker.token, attacker.product.id, [
      {
        // The rival's variant id, as read from the public product endpoint.
        id: victim.variant.id,
        optionValues: { size: 'M' },
        sellerPricePaise: 100, // ₹1 — the price-sabotage payload
        stock: 0,
        sku: 'PWNED',
      },
    ]);

    expect(status).toBe(404);
    expect(json.error?.code).toBe('VARIANT_NOT_ON_PRODUCT');

    // The database is the real assertion: the victim's row must be untouched.
    const after = await prisma.productVariant.findUnique({ where: { id: victim.variant.id } });
    expect(after).not.toBeNull();
    expect(after!.pricePaise).toBe(victim.variant.pricePaise);
    expect(after!.stock).toBe(victim.variant.stock);
    expect(after!.sku).toBe(victim.variant.sku);
    expect(after!.productId).toBe(victim.product.id);
  });

  it("refuses the seller's own variant when it belongs to a different product", async () => {
    // Scoping by seller instead of product would let this through, and would
    // still corrupt a listing — the constraint has to be productId, which is
    // what the deleteMany in the same transaction already uses.
    const seller = await makeSellerWithProduct('own-a');
    const other = await makeSellerWithProduct('own-b');
    const moved = await prisma.product.update({
      where: { id: other.product.id },
      data: { sellerId: seller.sellerId },
    });

    const { status, json } = await putProduct(seller.token, seller.product.id, [
      { id: other.variant.id, optionValues: { size: 'M' }, sellerPricePaise: 100, stock: 0 },
    ]);

    expect(status).toBe(404);
    expect(json.error?.code).toBe('VARIANT_NOT_ON_PRODUCT');

    const after = await prisma.productVariant.findUnique({ where: { id: other.variant.id } });
    expect(after!.pricePaise).toBe(other.variant.pricePaise);
    expect(after!.productId).toBe(moved.id);
  });

  it("refuses to overwrite another seller's variant images", async () => {
    // The images write is a second write keyed by the same body-supplied id.
    // It is scoped independently of the guard above precisely so this holds
    // even if that guard is ever lost, and this pins the behaviour either way.
    const attacker = await makeSellerWithProduct('img-attacker');
    const victim = await makeSellerWithProduct('img-victim');
    await prisma.productVariantImage.create({
      data: { variantId: victim.variant.id, url: '/uploads/victim-original.jpg', sortOrder: 0 },
    });

    const { status, json } = await putProduct(attacker.token, attacker.product.id, [
      {
        id: victim.variant.id,
        optionValues: { size: 'M' },
        sellerPricePaise: 100,
        stock: 0,
        imageUrls: ['/uploads/attacker-replacement.jpg'],
      },
    ]);

    expect(status).toBe(404);
    expect(json.error?.code).toBe('VARIANT_NOT_ON_PRODUCT');

    const after = await prisma.productVariantImage.findMany({
      where: { variantId: victim.variant.id },
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.url).toBe('/uploads/victim-original.jpg');
  });

  it('still lets a seller edit a variant that is genuinely theirs', async () => {
    // The guard is worthless if it also blocks the ordinary edit, so the happy
    // path is pinned here alongside the refusals.
    const seller = await makeSellerWithProduct('happy');

    const { status } = await putProduct(seller.token, seller.product.id, [
      {
        id: seller.variant.id,
        optionValues: { size: 'M' },
        sellerPricePaise: 55_500,
        stock: 7,
        sku: 'SKU-EDITED',
      },
    ]);

    expect(status).toBe(200);

    const after = await prisma.productVariant.findUnique({ where: { id: seller.variant.id } });
    // Before GST as sent; buyers pay it plus 18% (no category rule).
    expect([after!.sellerPricePaise, after!.pricePaise]).toEqual([55_500, 65_490]);
    expect(after!.stock).toBe(7);
    expect(after!.sku).toBe('SKU-EDITED');
  });
});
