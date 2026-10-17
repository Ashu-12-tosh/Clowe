import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { updateAiSettings } from '../services/aiMeter';
import { signAccessToken } from '../utils/jwt';
import { TEST_SELLER_ADDRESS } from '../test/fixture';

/**
 * AI with a budget and limits (mock provider here): every call is logged with
 * its tokens and cost; at the monthly budget or a shopper's daily limit, AI
 * Search answers with the normal search instead — never an error. AI Search,
 * Compare and recommendations show only our catalog's own products.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let categoryId: string;
const ids: string[] = [];
let adminToken: string;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string } } };
}

beforeAll(async () => {
  const cat = await prisma.category.create({ data: { name: 'Kurtas', slug: 'ai-kurtas', isActive: true } });
  categoryId = cat.id;
  const u = await prisma.user.create({ data: { phone: '9177300001', name: 'AI Seller', role: Role.SELLER, referralCode: 'AI-S-1' } });
  const s = await prisma.sellerProfile.create({ data: { ...TEST_SELLER_ADDRESS, userId: u.id, shopName: 'AI Shop', status: SellerStatus.APPROVED, approvedAt: new Date(), subscription: { create: { plan: 'GROWTH' } } } });
  for (const [i, title] of ['Cotton Kurta Blue', 'Silk Kurta Red', 'Linen Kurta White'].entries()) {
    const p = await prisma.product.create({
      data: {
        sellerId: s.id, categoryId, title, slug: `ai-kurta-${i}`, description: 'AI test kurta.', basePricePaise: 120_000 + i * 10_000,
        status: ProductStatus.APPROVED, approvedAt: new Date(), attributes: [{ key: 'fabric', label: 'Fabric', value: title.split(' ')[0] }],
        variants: { create: [{ optionValues: { size: 'M' }, optionsKey: 'size:M', label: 'M', size: 'M', color: '', sku: `AI-${i}`, pricePaise: 120_000 + i * 10_000, stock: 5 }] },
      },
    });
    ids.push(p.id);
  }
  const a = await prisma.user.create({ data: { phone: '9177300002', name: 'AI Admin', role: Role.ADMIN, referralCode: 'AI-A-1' } });
  adminToken = signAccessToken({ sub: a.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await updateAiSettings({ monthlyBudgetPaise: 100_000, shopperDailyCalls: 30 });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('AI Search', () => {
  it('turns a question into filters and shows only our products, logging tokens and cost', async () => {
    const before = await prisma.aiUsage.count();
    const r = await call<{ ai: boolean; answer: string | null; items: { id: string }[]; more: { id: string }[]; filters: { maxPricePaise: number | null } }>('GET', `/api/ai/search?q=${encodeURIComponent('cotton kurta under 1500')}`, null);
    expect(r.status).toBe(200);
    expect(r.json.data.ai).toBe(true);
    expect(r.json.data.filters.maxPricePaise).toBe(150_000);
    const shown = [...r.json.data.items, ...r.json.data.more].map((p) => p.id);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((id) => ids.includes(id))).toBe(true);
    // A Growth seller's products are the AI picks.
    expect(r.json.data.items.length).toBe(shown.length);
    const logged = await prisma.aiUsage.findFirstOrThrow({ where: { task: 'ai-search' }, orderBy: { createdAt: 'desc' } });
    expect(await prisma.aiUsage.count()).toBe(before + 1);
    expect(logged.inputTokens).toBeGreaterThan(0);
    expect(logged.costPaise).toBeGreaterThan(0);
    expect(logged.userKey).toMatch(/^ip:/);
  });

  it('at the monthly budget, answers with the normal search — never an error', async () => {
    await updateAiSettings({ monthlyBudgetPaise: 0 });
    const before = await prisma.aiUsage.count();
    const r = await call<{ ai: boolean; answer: string | null; more: { id: string }[] }>('GET', `/api/ai/search?q=${encodeURIComponent('kurta')}`, null);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ ai: false, answer: null });
    expect(r.json.data.more.length).toBeGreaterThan(0);
    expect(await prisma.aiUsage.count()).toBe(before); // nothing spent
    await updateAiSettings({ monthlyBudgetPaise: 100_000 });
  });

  it("past a shopper's daily limit, the same", async () => {
    await updateAiSettings({ shopperDailyCalls: 1 });
    const u = await prisma.user.create({ data: { phone: '9177300003', name: 'AI Shopper', referralCode: 'AI-U-1' } });
    const t = signAccessToken({ sub: u.id, role: 'CUSTOMER' });
    expect((await call<{ ai: boolean }>('GET', '/api/ai/search?q=silk%20kurta', t)).json.data.ai).toBe(true);
    expect((await call<{ ai: boolean }>('GET', '/api/ai/search?q=silk%20kurta', t)).json.data.ai).toBe(false);
    await updateAiSettings({ shopperDailyCalls: 30 });
  });
});

describe('Compare', () => {
  it('lines up our data side by side, and the summary is written from it', async () => {
    const v = await call<{ products: { id: string; pricePaise: number; attributes: Record<string, string>; sellerName: string; returns: string }[]; attributeLabels: string[] }>('GET', `/api/ai/compare?ids=${ids.join(',')}`, null);
    expect(v.json.data.products.map((p) => p.id)).toEqual(ids);
    expect(v.json.data.attributeLabels).toContain('Fabric');
    expect(v.json.data.products[0]).toMatchObject({ sellerName: 'AI Shop', attributes: { Fabric: 'Cotton' } });
    const s = await call<{ summary: string | null; ai: boolean }>('POST', '/api/ai/compare-summary', null, { ids: ids.slice(0, 2), needs: 'summer wear' });
    expect(s.json.data.ai).toBe(true);
    expect(s.json.data.summary).toContain('Cotton Kurta Blue');
    expect((await call<{ summary: string | null }>('POST', '/api/ai/compare-summary', null, { ids: ids.slice(0, 1) })).json.data.summary).toBeNull();
    expect((await call('GET', `/api/ai/compare?ids=${[...ids, 'x', 'y'].join(',')}`, null)).status).toBe(400); // more than four
  });

  it('recommendations come only from the product’s own category', async () => {
    const r = await call<{ items: { id: string }[] }>('GET', `/api/ai/recommendations/${ids[0]}`, null);
    expect(r.json.data.items.every((p) => ids.slice(1).includes(p.id))).toBe(true);
  });
});

describe('the admin view', () => {
  it('shows spend against the budget and saves the settings', async () => {
    const v = await call<{ calls: number; spentPaise: number; byTask: { task: string }[]; settings: { monthlyBudgetPaise: number } }>('GET', '/api/admin/ai', adminToken);
    expect(v.json.data.calls).toBeGreaterThan(0);
    expect(v.json.data.byTask.map((t) => t.task)).toContain('ai-search');
    expect((await call<{ monthlyBudgetPaise: number }>('PATCH', '/api/admin/ai', adminToken, { monthlyBudgetPaise: 200_000 })).json.data.monthlyBudgetPaise).toBe(200_000);
    expect((await call('PATCH', '/api/admin/ai', adminToken, { monthlyBudgetPaise: -1 })).status).toBe(400);
  });
});
