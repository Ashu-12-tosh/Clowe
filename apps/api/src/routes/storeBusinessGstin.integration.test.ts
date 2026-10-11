import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * Saving business details without a GSTIN field keeps the one on file:
 * absent is not empty. Payouts and every tax invoice depend on it, so a
 * client that sends only the fields it changed must not wipe it. An explicit
 * empty value still clears it.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let sellerId: string;
const GSTIN = '27ABCDE1234F1Z5';

const save = async (body: Record<string, unknown>) =>
  (
    await fetch(`${base}/api/seller/store/business`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).status;
const stored = async () => (await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } })).gstNumber;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { phone: '9198300001', name: 'Gstin Keeper', role: Role.SELLER, referralCode: 'GSTK-1' },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'Gstin Keeper Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), gstNumber: GSTIN },
  });
  sellerId = seller.id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('saving business details', () => {
  it('without the GSTIN field keeps the GSTIN on file', async () => {
    expect(await save({ panNumber: 'ABCDE1234F', panName: 'Gstin Keeper', city: 'Pune', state: 'Maharashtra', pincode: '411001' })).toBe(200);
    expect(await stored()).toBe(GSTIN);
  });

  it('with an explicit empty GSTIN clears it', async () => {
    expect(await save({ gstNumber: '', panNumber: 'ABCDE1234F', panName: 'Gstin Keeper' })).toBe(200);
    expect(await stored()).toBeNull();
  });

  it('with a GSTIN sets it', async () => {
    expect(await save({ gstNumber: GSTIN })).toBe(200);
    expect(await stored()).toBe(GSTIN);
  });
});
