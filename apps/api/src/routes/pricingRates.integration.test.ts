import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { computeListingEconomics, type SellerEconomicsRates } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { signAccessToken } from '../utils/jwt';

/**
 * GET /api/seller/pricing-rates: the rates behind the product form's live
 * breakdown. The point of the endpoint is that the form and the ledger run
 * the same formula on the same numbers, so the test checks the served rates
 * are the settings in force, and that they move when an admin moves them.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;

beforeAll(async () => {
  await seedFixture(prisma);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await setSetting('gstRatePercent', DEFAULT_SETTINGS.gstRatePercent);
  await setSetting('closingFeePaise', DEFAULT_SETTINGS.closingFeePaise);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function sellerToken() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `91500${String(seq).padStart(5, '0')}`, name: `Rates Seller ${seq}`, role: Role.SELLER, referralCode: `RT-S-${seq}` },
  });
  await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `Rates Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  return signAccessToken({ sub: user.id, role: 'SELLER' });
}

async function rates(token: string) {
  const res = await fetch(`${base}/api/seller/pricing-rates`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as { data?: SellerEconomicsRates; error?: { code: string } } };
}

describe('GET /api/seller/pricing-rates', () => {
  it('serves every rate the calculator needs, from settings', async () => {
    const { status, json } = await rates(await sellerToken());
    expect(status).toBe(200);
    expect(json.data).toEqual({
      commissionPercent: DEFAULT_SETTINGS.payoutCommissionPercent,
      gatewayPercent: DEFAULT_SETTINGS.payoutGatewayPercent,
      tdsPercent: DEFAULT_SETTINGS.payoutTdsPercent,
      gstPercent: DEFAULT_SETTINGS.gstRatePercent,
      platformFeePaise: DEFAULT_SETTINGS.platformFeePaise,
      deliveryFeePaise: DEFAULT_SETTINGS.deliveryFeePaise,
      closingFeePaise: DEFAULT_SETTINGS.closingFeePaise,
    });
  });

  it('follows the settings, so the form and the ledger move together', async () => {
    await setSetting('gstRatePercent', 5);
    await setSetting('closingFeePaise', 0);
    const { json } = await rates(await sellerToken());
    expect(json.data?.gstPercent).toBe(5);
    expect(json.data?.closingFeePaise).toBe(0);
    // And the breakdown the form would show from these rates:
    const e = computeListingEconomics({ sellerPricePaise: 100_000, rates: json.data! });
    expect(e.gstPaise).toBe(100_000 - 95_238);
    expect(e.closingFeePaise).toBe(0);
  });

  it('is for sellers only', async () => {
    seq += 1;
    const shopper = await prisma.user.create({
      data: { phone: `91600${String(seq).padStart(5, '0')}`, name: `Rates Shopper ${seq}`, referralCode: `RT-U-${seq}` },
    });
    const { status } = await rates(signAccessToken({ sub: shopper.id, role: 'CUSTOMER' }));
    expect(status).toBe(403);
    const anon = await fetch(`${base}/api/seller/pricing-rates`);
    expect(anon.status).toBe(401);
  });
});
