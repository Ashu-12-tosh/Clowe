import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CspReportRow } from '@clowe/shared';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let customerToken: string;

beforeAll(async () => {
  await seedFixture(prisma);
  await prisma.cspReport.deleteMany();
  const admin = await prisma.user.create({ data: { phone: '9700000001', name: 'CSP Admin', role: Role.ADMIN, referralCode: 'CSP-A-1' } });
  const customer = await prisma.user.create({ data: { phone: '9700000002', name: 'CSP Customer', referralCode: 'CSP-C-1' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  customerToken = signAccessToken({ sub: customer.id, role: 'CUSTOMER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

const report = (contentType: string, body: unknown) =>
  fetch(`${base}/api/csp-reports`, { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body) });

const legacy = (page: string) => ({
  'csp-report': {
    'document-uri': `https://cloweshop.com${page}?token=secret`,
    'violated-directive': 'img-src',
    'blocked-uri': 'https://tracker.example/p.gif',
    disposition: 'report',
  },
});

describe('POST /api/csp-reports', () => {
  it('accepts both browser formats without credentials and answers 204', async () => {
    expect((await report('application/csp-report', legacy('/cart'))).status).toBe(204);
    const modern = [
      {
        type: 'csp-violation',
        body: { documentURL: 'https://cloweshop.com/cart', effectiveDirective: 'img-src', blockedURL: 'https://tracker.example/q.gif', disposition: 'report' },
      },
    ];
    expect((await report('application/reports+json', modern)).status).toBe(204);
  });

  it('groups repeats into one row with a count, keeping no query string', async () => {
    const rows = await prisma.cspReport.findMany({ where: { page: '/cart' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ directive: 'img-src', blocked: 'https://tracker.example', count: 2 });
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('is not written to the audit log', async () => {
    expect(await prisma.auditLog.count({ where: { metadata: { path: ['path'], string_contains: 'csp-reports' } } })).toBe(0);
  });

  it('answers 204 to junk, and records nothing for it', async () => {
    const before = await prisma.cspReport.count();
    expect((await report('application/json', { hello: 'world' })).status).toBe(204);
    expect(await prisma.cspReport.count()).toBe(before);
  });
});

describe('GET /api/admin/audit/csp-reports', () => {
  it('lists the groups for an admin', async () => {
    const res = await fetch(`${base}/api/admin/audit/csp-reports`, { headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: CspReportRow[] };
    expect(data.find((r) => r.page === '/cart')?.count).toBe(2);
  });

  it('is admin-only', async () => {
    const res = await fetch(`${base}/api/admin/audit/csp-reports`, { headers: { authorization: `Bearer ${customerToken}` } });
    expect(res.status).toBe(403);
  });
});
