import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * Registering a shop makes a customer a SELLER, but never demotes an admin:
 * on production the only admin registering a test shop locked everyone out
 * of the admin panel.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

async function registerAs(phone: string, role: Role, shopName: string) {
  const user = await prisma.user.create({
    data: { phone, name: shopName, role, referralCode: `REG-${phone.slice(-4)}` },
  });
  const res = await fetch(`${base}/api/seller/register`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${signAccessToken({ sub: user.id, role })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ shopName }),
  });
  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { sellerProfile: true } });
  return { status: res.status, role: after.role, shop: after.sellerProfile };
}

beforeAll(() => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('registering a shop', () => {
  it('makes a customer a seller', async () => {
    const r = await registerAs('9198500001', Role.CUSTOMER, 'Customer Shop');
    expect([r.status, r.role, r.shop?.status]).toEqual([200, 'SELLER', 'PENDING']);
  });

  it('leaves an admin an admin, with the shop created', async () => {
    const r = await registerAs('9198500002', Role.ADMIN, 'Admin Shop');
    expect([r.status, r.role, r.shop?.shopName]).toEqual([200, 'ADMIN', 'Admin Shop']);
  });
});
