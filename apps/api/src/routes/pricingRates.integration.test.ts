import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { computeListingEconomics, type SellerEconomicsRates } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { DEFAULT_SETTINGS, getSettings, setSetting } from '../services/settingsService';
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
  await setSetting('gstValueSlabThresholdPaise', DEFAULT_SETTINGS.gstValueSlabThresholdPaise);
  await setSetting('closingFeePaise', DEFAULT_SETTINGS.closingFeePaise);
  await setSetting('payoutTdsPercent', DEFAULT_SETTINGS.payoutTdsPercent);
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
      tcsPercent: DEFAULT_SETTINGS.gstTcsPercent,
      gst: {
        meritPercent: DEFAULT_SETTINGS.gstMeritPercent,
        standardPercent: DEFAULT_SETTINGS.gstStandardPercent,
        valueSlabThresholdPaise: DEFAULT_SETTINGS.gstValueSlabThresholdPaise,
      },
      platformFeePaise: DEFAULT_SETTINGS.platformFeePaise,
      deliveryFeePaise: DEFAULT_SETTINGS.deliveryFeePaise,
      closingFeePaise: DEFAULT_SETTINGS.closingFeePaise,
      gtChargePaise: DEFAULT_SETTINGS.gtChargePaise,
    });
  });

  it('follows the settings, so the form and the ledger move together', async () => {
    // Lower the value-slab threshold to ₹1,000: an apparel piece the seller
    // prices at ₹1,000 (before GST) is 5%, and a paisa more is 18%.
    await setSetting('gstValueSlabThresholdPaise', 100_000);
    await setSetting('closingFeePaise', 0);
    const { json } = await rates(await sellerToken());
    expect(json.data?.gst.valueSlabThresholdPaise).toBe(100_000);
    expect(json.data?.closingFeePaise).toBe(0);
    // And the breakdown the form would show from these rates:
    const slab = { taxRule: 'VALUE_SLAB' as const, defaultTaxRatePercent: null };
    expect(computeListingEconomics({ sellerPricePaise: 100_000, rates: json.data!, taxRules: slab }).gstRatePercent).toBe(5);
    const e = computeListingEconomics({ sellerPricePaise: 100_001, rates: json.data!, taxRules: slab });
    expect(e.gstRatePercent).toBe(18);
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

describe('the TDS rate migration', () => {
  // The statement the migration ships, run against stored values: the old 1%
  // default is corrected to the 0.1% in force since 1.10.2024; a rate an admin
  // set on purpose is left alone.
  const sql = readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/20261002130000_tds_tcs_current_rates/migration.sql'),
    'utf8',
  );
  const update = sql.split(/\r?\n/).find((l) => l.startsWith('UPDATE "platform_settings"'))!;

  it('corrects a stored 1%', async () => {
    await setSetting('payoutTdsPercent', 1);
    await prisma.$executeRawUnsafe(update);
    expect((await getSettings()).payoutTdsPercent).toBe(0.1);
  });

  it('leaves a deliberate rate alone', async () => {
    await setSetting('payoutTdsPercent', 0.5);
    await prisma.$executeRawUnsafe(update);
    expect((await getSettings()).payoutTdsPercent).toBe(0.5);
  });

  it('defaults to the rates in force', () => {
    expect(DEFAULT_SETTINGS.payoutTdsPercent).toBe(0.1);
    expect(DEFAULT_SETTINGS.gstTcsPercent).toBe(0.5);
  });
});
