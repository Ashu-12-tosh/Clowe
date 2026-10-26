import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { getCommercial, updateCommercial } from '../services/commercial';
import { applyDueFeeChanges } from '../services/feeChanges';
import { signAccessToken } from '../utils/jwt';

/**
 * Fee changes announced ahead (owner's Batch 2): never less than 30 days'
 * notice; every approved seller told (dashboard, SMS, email); applied by
 * itself on the date; cancellable before it, with sellers told.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let admin: string;
let sellerUserId: string;
let sellerToken: string;
const DAY = 86_400_000;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

beforeAll(async () => {
  const a = await prisma.user.create({ data: { phone: '9198810001', name: 'Fee Admin', role: Role.ADMIN, referralCode: 'FEE-A-1' } });
  admin = signAccessToken({ sub: a.id, role: 'ADMIN' });
  const u = await prisma.user.create({ data: { phone: '9198810002', name: 'Fee Seller', role: Role.SELLER, referralCode: 'FEE-S-1' } });
  await prisma.sellerProfile.create({ data: { userId: u.id, shopName: 'Fee Shop', status: SellerStatus.APPROVED, approvedAt: new Date() } });
  sellerUserId = u.id;
  sellerToken = signAccessToken({ sub: u.id, role: 'SELLER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await updateCommercial({ fees: { gtPercent: 1.5 } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('scheduling a fee change', () => {
  it('refuses less than 30 days’ notice', async () => {
    const r = await call('POST', '/api/admin/fee-changes', admin, { patch: { fees: { gtPercent: 2 } }, effectiveAt: new Date(Date.now() + 20 * DAY).toISOString() });
    expect(r.json.error?.code).toBe('NOTICE_TOO_SHORT');
  });

  it('refuses a change that changes nothing, or an invalid one', async () => {
    const at = new Date(Date.now() + 40 * DAY).toISOString();
    expect((await call('POST', '/api/admin/fee-changes', admin, { patch: { fees: { gtPercent: 1.5 } }, effectiveAt: at })).json.error?.code).toBe('NO_CHANGE');
    expect((await call('POST', '/api/admin/fee-changes', admin, { patch: { fees: { gtPercent: 'two' } }, effectiveAt: at })).json.error?.code).toBe('COMMERCIAL_INVALID');
  });

  it('tells sellers, shows it to them, and applies it on the date', async () => {
    const at = new Date(Date.now() + 31 * DAY);
    const r = await call<{ id: string; summary: string; sellersTold: number }>('POST', '/api/admin/fee-changes', admin, { patch: { fees: { gtPercent: 2 } }, effectiveAt: at.toISOString() });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.data.summary).toBe('fees.gtPercent: 1.5 → 2');
    expect(r.json.data.sellersTold).toBeGreaterThanOrEqual(1);
    expect(await prisma.notification.count({ where: { userId: sellerUserId, type: 'FEE_CHANGE' } })).toBe(1);
    const shown = await call<{ id: string }[]>('GET', '/api/seller/billing/fee-changes', sellerToken);
    expect(shown.json.data.map((c) => c.id)).toContain(r.json.data.id);

    // Not before its date…
    await applyDueFeeChanges(new Date(at.getTime() - 60_000));
    expect((await getCommercial()).fees.gtPercent).toBe(1.5);
    // …and on it, once.
    expect(await applyDueFeeChanges(new Date(at.getTime() + 60_000))).toBe(1);
    expect(await applyDueFeeChanges(new Date(at.getTime() + 120_000))).toBe(0);
    expect((await getCommercial()).fees.gtPercent).toBe(2);
    expect((await prisma.scheduledFeeChange.findUniqueOrThrow({ where: { id: r.json.data.id } })).status).toBe('APPLIED');
  });

  it('can be cancelled before its date, and sellers are told', async () => {
    const r = await call<{ id: string }>('POST', '/api/admin/fee-changes', admin, { patch: { penalties: { counterfeitListingPaise: 20_000 } }, effectiveAt: new Date(Date.now() + 45 * DAY).toISOString() });
    const before = await prisma.notification.count({ where: { userId: sellerUserId, type: 'FEE_CHANGE' } });
    expect((await call('POST', `/api/admin/fee-changes/${r.json.data.id}/cancel`, admin)).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: sellerUserId, type: 'FEE_CHANGE' } })).toBe(before + 1);
    expect(await applyDueFeeChanges(new Date(Date.now() + 50 * DAY))).toBe(0);
    expect((await call('POST', `/api/admin/fee-changes/${r.json.data.id}/cancel`, admin)).json.error?.code).toBe('NOT_SCHEDULED');
    // Sellers never schedule.
    expect((await call('POST', '/api/admin/fee-changes', sellerToken, { patch: {}, effectiveAt: new Date().toISOString() })).status).toBe(403);
  });
});
