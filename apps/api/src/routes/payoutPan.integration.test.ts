import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SellerPayoutOverview } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { postDeliveryEntries } from '../services/sellerLedgerService';
import { encryptBankAccount } from '../services/bankAccountCrypto';
import { reviewSellerKyc } from '../services/kyc/sellerKyc';

/**
 * No payout without a verified PAN — checked when the money moves, not only
 * at approval, which an admin can wave through with warnings acknowledged.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let categoryId: string;
let seq = 0;
const PRICE = 300_000;

beforeAll(async () => {
  await seedFixture(prisma);
  categoryId = (await prisma.category.findFirstOrThrow({ where: { isActive: true } })).id;
  const admin = await prisma.user.create({
    data: { phone: '9160000000', name: 'PAN Admin', role: Role.ADMIN, referralCode: 'PAN-A' },
  });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  await setSetting('payoutHoldDays', 0);
  // Lines written here carry no window of their own, so the platform's applies:
  // cleared at once, and sent without waiting for an admin (approval has its own tests).
  await setSetting('returnWindowDays', 0);
  await setSetting('payoutAutoApprove', true);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await setSetting('payoutHoldDays', DEFAULT_SETTINGS.payoutHoldDays);
  await setSetting('returnWindowDays', DEFAULT_SETTINGS.returnWindowDays);
  await setSetting('payoutAutoApprove', DEFAULT_SETTINGS.payoutAutoApprove);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as { data?: unknown; error?: { code: string; message: string } },
  };
}

interface Profile {
  panNumber?: string;
  panName?: string;
  status?: SellerStatus;
  kycStatus?: 'VERIFIED';
}

/**
 * A seller with cleared earnings and a verified payout method: everything a
 * payout needs except, unless given, a PAN.
 */
async function payableSeller(profile: Profile = {}) {
  seq += 1;
  const status = profile.status ?? SellerStatus.APPROVED;
  const user = await prisma.user.create({
    data: {
      phone: `91600${String(seq).padStart(5, '0')}`,
      name: `PAN Seller ${seq}`,
      role: Role.SELLER,
      referralCode: `PAN-S-${seq}`,
    },
  });
  const seller = await prisma.sellerProfile.create({
    data: {
      userId: user.id,
      shopName: `PAN Shop ${seq}`,
      status,
      approvedAt: status === SellerStatus.APPROVED ? new Date() : null,
      panNumber: profile.panNumber ?? null,
      panName: profile.panName ?? null,
      // A GSTIN and a bank account are required for payouts; these tests are
      // about the PAN, so both are on file and verified by an admin below.
      gstNumber: '27ABCDE1234F1Z0',
      bankAccountEnc: encryptBankAccount('1234567890'),
      bankAccountLast4: '7890',
      bankIfsc: 'HDFC0001234',
      bankAccountName: `PAN Seller ${seq}`,
      ...(profile.kycStatus ? { kycStatus: profile.kycStatus } : {}),
    },
  });
  for (const check of ['GSTIN', 'BANK'] as const) await reviewSellerKyc({ sellerId: seller.id, check, decision: 'VERIFY', reviewerId: 'test-admin' });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId,
      title: `PAN ${seq}`,
      slug: `pan-${seq}`,
      description: 'PAN payout test listing.',
      basePricePaise: PRICE,
      status: ProductStatus.APPROVED,
      approvedAt: new Date(),
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      optionValues: {},
      optionsKey: '',
      label: '',
      size: '',
      color: '',
      sku: `PAN-SKU-${seq}`,
      pricePaise: PRICE,
      stock: 5,
    },
  });
  const shopper = await prisma.user.create({
    data: { phone: `91700${String(seq).padStart(5, '0')}`, name: 'PAN Shopper', referralCode: `PAN-U-${seq}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `CLW-PAN-${seq}`,
      userId: shopper.id,
      shipName: 'S',
      shipPhone: '9170000000',
      shipLine1: '1 Lane',
      shipCity: 'City',
      shipState: 'Maharashtra',
      shipPincode: '400001',
      status: 'DELIVERED',
      subtotalPaise: PRICE,
      totalPaise: PRICE,
      paymentMethod: 'UPI',
    },
  });
  const deliveredAt = new Date(Date.now() - 60_000);
  const item = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId: product.id,
      variantId: variant.id,
      sellerId: seller.id,
      title: 'pan',
      size: '',
      color: '',
      pricePaise: PRICE,
      quantity: 1,
      status: 'DELIVERED',
      shippedAt: deliveredAt,
      deliveredAt,
    },
  });
  await postDeliveryEntries(item.id);
  await prisma.sellerPayoutMethod.create({
    data: {
      sellerId: seller.id,
      type: 'UPI',
      label: 'UPI',
      accountName: `PAN Seller ${seq}`,
      upiId: `pan${seq}@upi`,
      isDefault: true,
      verified: true,
    },
  });
  return { sellerId: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

/** The request is refused, the overview says why, and no money moved. */
async function expectBlocked(s: { sellerId: string; token: string }, panState: string, says: RegExp) {
  const res = await call('POST', '/api/seller/payouts/request', s.token, {});
  expect(res.status).toBe(403);
  expect(res.json.error?.code).toBe('PAN_NOT_VERIFIED');
  expect(res.json.error?.message).toMatch(says);
  expect(await prisma.payout.count({ where: { sellerId: s.sellerId } })).toBe(0);
  expect(await prisma.sellerLedgerEntry.count({ where: { sellerId: s.sellerId, type: 'PAYOUT' } })).toBe(0);

  const overview = (await call('GET', '/api/seller/payouts/overview', s.token)).json.data as SellerPayoutOverview;
  expect(overview.panBlock).toMatchObject({ code: 'PAN_NOT_VERIFIED', panState });
  // Waiting for an admin: nothing for the seller to do. Otherwise, where to fix it.
  if (panState === 'PENDING_REVIEW') expect(overview.panBlock!.action).toMatch(/Nothing to do/);
  else expect(overview.panBlock!.action).toContain('Store settings → Business');
  // Not "you can request a payout now" while it cannot be done.
  expect(overview.insights.map((i) => i.key)).toContain('pan');
  expect(overview.insights.map((i) => i.key)).not.toContain('payable');
}

describe('a payout without a verified PAN', () => {
  it('is refused for a seller an admin approved with "PAN not provided" acknowledged', async () => {
    const s = await payableSeller({ status: SellerStatus.PENDING });
    const unacknowledged = await call('PATCH', `/api/admin/sellers/${s.sellerId}/status`, adminToken, {
      action: 'approve',
    });
    expect(unacknowledged.status).toBe(409);
    const approved = await call('PATCH', `/api/admin/sellers/${s.sellerId}/status`, adminToken, {
      action: 'approve',
      acknowledgeKycWarnings: true,
    });
    expect(approved.status).toBe(200);
    await expectBlocked(s, 'NOT_PROVIDED', /no PAN on file/);
  });

  it('is refused while the PAN on file waits for review, saying so', async () => {
    // No verification provider: an admin checks the PAN against the card.
    await expectBlocked(await payableSeller({ panNumber: 'ABCDE1234F' }), 'PENDING_REVIEW', /waiting for Clowe to verify it/);
    await expectBlocked(
      await payableSeller({ panNumber: 'ABCDE1234F', panName: 'Pan Holder' }),
      'PENDING_REVIEW',
      /waiting for Clowe to verify it/,
    );
    await expectBlocked(
      await payableSeller({ panNumber: 'ABC1234', panName: 'Pan Holder' }),
      'INVALID_FORMAT',
      /not a valid PAN/,
    );
  });

  it('is refused after a mock check (never a verification) and when an admin rejected the PAN', async () => {
    // A mock "verified" is no verification: the PAN still waits for review.
    const mocked = await payableSeller({ panNumber: 'ABCDE1234F', panName: 'Pan Holder' });
    expect((await call('POST', '/api/seller/kyc/verify', mocked.token)).status).toBe(200);
    await expectBlocked(mocked, 'PENDING_REVIEW', /waiting for Clowe to verify it/);

    const rejected = await payableSeller({ panNumber: 'ZZZZZ1234F', panName: 'Pan Holder' });
    await reviewSellerKyc({ sellerId: rejected.sellerId, check: 'PAN', decision: 'REJECT', reason: 'The name does not match the PAN card', reviewerId: 'test-admin' });
    await expectBlocked(rejected, 'REJECTED', /not accepted: The name does not match the PAN card/);
  });

  it('goes through once the seller adds the PAN and an admin verifies it', async () => {
    const s = await payableSeller();
    await expectBlocked(s, 'NOT_PROVIDED', /no PAN on file/);
    // The business form saves every field, the GSTIN on file included.
    const saved = await call('PUT', '/api/seller/store/business', s.token, {
      panNumber: 'ABCDE1234F',
      panName: 'Pan Holder',
      gstNumber: '27ABCDE1234F1Z0',
    });
    expect(saved.status).toBe(200);
    expect((await call('POST', '/api/seller/kyc/verify', s.token)).status).toBe(200);
    await expectBlocked(s, 'PENDING_REVIEW', /waiting for Clowe/); // the mock check verified nothing
    await reviewSellerKyc({ sellerId: s.sellerId, check: 'PAN', decision: 'VERIFY', reviewerId: 'test-admin' });

    const overview = (await call('GET', '/api/seller/payouts/overview', s.token)).json.data as SellerPayoutOverview;
    expect(overview.panBlock).toBeNull();
    const paid = await call('POST', '/api/seller/payouts/request', s.token, {});
    expect(paid.status).toBe(200);
    expect((paid.json.data as { status: string }).status).toBe('PAID');
  });
});

describe('a verified PAN is locked', () => {
  it('can be added when never on file, but not changed once an admin verified it', async () => {
    const s = await payableSeller({ kycStatus: 'VERIFIED' });
    const added = await call('PUT', '/api/seller/store/business', s.token, {
      panNumber: 'ABCDE1234F',
      panName: 'Pan Holder',
    });
    expect(added.status).toBe(200);
    expect(await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.sellerId } })).toMatchObject({
      panNumber: 'ABCDE1234F',
      panName: 'Pan Holder',
    });
    await reviewSellerKyc({ sellerId: s.sellerId, check: 'PAN', decision: 'VERIFY', reviewerId: 'test-admin' });

    const changed = await call('PUT', '/api/seller/store/business', s.token, {
      panNumber: 'PQRST5678K',
      panName: 'Pan Holder',
    });
    expect(changed.status).toBe(400);
    expect(changed.json.error?.code).toBe('KYC_LOCKED');
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.sellerId } })).panNumber).toBe('ABCDE1234F');
  });
});
