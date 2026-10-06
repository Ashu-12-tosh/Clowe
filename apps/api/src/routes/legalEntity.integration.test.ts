import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * The legal entity settings: seeded with the registered name and nothing
 * else, edited from admin one field at a time, validated, and public — the
 * footer, Contact Us and the policy pages all read them from here.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } } };
}
const publicLegal = async () => (await call('GET', '/api/settings/public', null)).json.data!.legalEntity;

beforeAll(async () => {
  await prisma.platformSetting.deleteMany({ where: { key: 'legalEntity' } });
  const admin = await prisma.user.create({
    data: { phone: '9197000001', name: 'Legal Admin', role: Role.ADMIN, referralCode: 'LEGAL-A' },
  });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.platformSetting.deleteMany({ where: { key: 'legalEntity' } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('legal entity settings', () => {
  it('start with the registered name and every other field empty, readable without signing in', async () => {
    expect(await publicLegal()).toEqual({
      name: 'CLOWE PARTNERS LLP',
      registeredAddress: '',
      llpin: '',
      gstin: '',
      supportEmail: '',
      supportPhone: '',
    });
  });

  it('save from admin, a field at a time, without blanking the rest', async () => {
    const first = await call('PUT', '/api/admin/settings', adminToken, {
      legalEntity: { registeredAddress: '12 MG Road, Bengaluru 560001', gstin: ' 29abcde1234f1z5 ' },
    });
    expect(first.status).toBe(200);
    const second = await call('PUT', '/api/admin/settings', adminToken, {
      legalEntity: { supportEmail: 'help@cloweshop.com' },
    });
    expect(second.status).toBe(200);

    expect(await publicLegal()).toEqual({
      name: 'CLOWE PARTNERS LLP',
      registeredAddress: '12 MG Road, Bengaluru 560001',
      llpin: '',
      // Trimmed and upper-cased on the way in.
      gstin: '29ABCDE1234F1Z5',
      supportEmail: 'help@cloweshop.com',
      supportPhone: '',
    });
  });

  it.each([
    [{ name: '  ' }, 'The legal name cannot be empty'],
    [{ llpin: '1234' }, 'LLPIN looks like AAB-1234'],
    [{ gstin: 'GST123' }, 'GSTIN is 15 characters'],
    [{ supportEmail: 'not-an-email' }, 'Enter a valid email address'],
    [{ supportPhone: 'call us' }, 'Enter a phone number'],
  ])('refuses %o', async (legalEntity, message) => {
    const res = await call('PUT', '/api/admin/settings', adminToken, { legalEntity });
    expect(res.status).toBe(400);
    expect(res.json.error?.message).toContain(message);
  });

  it('clearing a field empties it (and the site hides it)', async () => {
    await call('PUT', '/api/admin/settings', adminToken, { legalEntity: { gstin: '' } });
    expect((await publicLegal() as { gstin: string }).gstin).toBe('');
  });

  it('only an admin can change them', async () => {
    const res = await call('PUT', '/api/admin/settings', null, { legalEntity: { name: 'SOMEONE ELSE LLP' } });
    expect(res.status).toBe(401);
    expect((await publicLegal() as { name: string }).name).toBe('CLOWE PARTNERS LLP');
  });
});
