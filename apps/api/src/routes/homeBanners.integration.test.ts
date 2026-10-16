import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { signAccessToken } from '../utils/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { bustHomeCache } from './home';

/**
 * A hero slide stays on the homepage while its category is still filling
 * (the owner's call for the Electronics slide); it goes only when it leads
 * into a category shoppers cannot see at all (the closed food categories).
 * Promo tiles still drop when their department is empty.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;

beforeAll(async () => {
  await prisma.category.create({ data: { name: 'Banner Gadgets', slug: 'banner-gadgets', isActive: true } });
  await prisma.category.upsert({ where: { slug: 'grocery' }, update: {}, create: { name: 'Grocery', slug: 'grocery', isActive: true } });
  await prisma.homeBanner.createMany({
    data: [
      { headline: 'Gadgets, coming soon', primaryLabel: 'Shop', primaryHref: '/products?category=banner-gadgets', sortOrder: 901 },
      { headline: 'Fresh groceries', primaryLabel: 'Shop', primaryHref: '/products?category=grocery', sortOrder: 902 },
    ],
  });
  await prisma.promoTile.create({ data: { title: 'Gadget deals', href: '/products?category=banner-gadgets', placement: 'PROMO_CARD', sortOrder: 901 } });
  bustHomeCache();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.homeBanner.deleteMany({ where: { sortOrder: { in: [901, 902] } } });
  await prisma.promoTile.deleteMany({ where: { sortOrder: 901 } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('hero slides', () => {
  it('keeps a slide into a category with nothing live yet, drops one into a closed category, and still drops the empty tile', async () => {
    const home = ((await (await fetch(`${base}/api/home`)).json()) as { data: { banners: { headline: string }[]; promoCards: { href: string }[] } }).data;
    const headlines = home.banners.map((b) => b.headline);
    expect(headlines).toContain('Gadgets, coming soon');
    expect(headlines).not.toContain('Fresh groceries');
    expect(home.promoCards.map((c) => c.href)).not.toContain('/products?category=banner-gadgets');
  });
});

describe('a category landing page’s callouts', () => {
  it('are edited through the admin category update, replacing the old “Easy Returns” line', async () => {
    const admin = await prisma.user.create({ data: { phone: '9198900001', name: 'Callout Admin', role: Role.ADMIN, referralCode: 'CALLOUT-A' } });
    const token = signAccessToken({ sub: admin.id, role: 'ADMIN' });
    const cat = await prisma.category.update({
      where: { slug: 'banner-gadgets' },
      data: { features: [{ icon: '↩', title: 'Easy Returns', subtitle: 'Hassle-free return policy.' }] },
    });
    const features = [{ icon: '↩', title: 'Damage & Wrong-Item Protection', subtitle: '48-hour claims, exchange or refund.' }];
    const res = await fetch(`${base}/api/admin/categories/${cat.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ features }),
    });
    expect(res.status).toBe(200);
    const page = (await (await fetch(`${base}/api/categories/banner-gadgets`)).json()) as { data: { features: unknown[] } };
    expect(page.data.features).toEqual(features);
  });
});
