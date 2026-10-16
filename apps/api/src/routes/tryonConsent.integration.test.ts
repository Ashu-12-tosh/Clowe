import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRYON_CONSENT_VERSION } from '@clowe/shared';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * AI Try-On consent (Privacy Policy 3): no try-on photo is taken, and no
 * try-on runs, until the shopper confirms they are 18+ and the photo is of
 * them or of a consenting adult. The consent is stored with its time and
 * wording; withdrawing it deletes every try-on photo of theirs at once.
 */
const prisma = new PrismaClient();
let server: Server;
let base: string;
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(() => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

let seq = 0;
async function shopper() {
  seq += 1;
  const u = await prisma.user.create({ data: { phone: `95800${String(seq).padStart(5, '0')}`, name: 'Consent Shopper', referralCode: `TC-${seq}` } });
  return { id: u.id, token: signAccessToken({ sub: u.id, role: 'CUSTOMER' }) };
}
const upload = (token: string) => {
  const form = new FormData();
  form.append('purpose', 'TRYON_PHOTO');
  form.append('images', new Blob([TINY_PNG], { type: 'image/png' }), 'me.png');
  return fetch(`${base}/api/uploads/private`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
};
const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

describe('try-on consent', () => {
  it('no try-on photo is accepted before it', async () => {
    const s = await shopper();
    const res = await upload(s.token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TRYON_CONSENT_REQUIRED');
    // Other private photos (a return's) are not affected.
    const form = new FormData();
    form.append('purpose', 'RETURN_PHOTO');
    form.append('images', new Blob([TINY_PNG], { type: 'image/png' }), 'r.png');
    expect((await fetch(`${base}/api/uploads/private`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: form })).status).toBe(200);
  });

  it('a ticked box (and only that) is stored with its time and wording, then uploads are accepted', async () => {
    const s = await shopper();
    expect((await call('POST', '/api/tryon/consent', s.token, { accepted: false })).status).toBe(400);
    expect((await call('POST', '/api/tryon/consent', s.token, { accepted: true })).status).toBe(200);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: s.id } });
    expect(u.tryOnConsentVersion).toBe(TRYON_CONSENT_VERSION);
    expect(u.tryOnConsentAt).not.toBeNull();
    expect((await upload(s.token)).status).toBe(200);
    const quota = (await (await call('GET', '/api/tryon/quota', s.token)).json()) as { data: { consented: boolean } };
    expect(quota.data.consented).toBe(true);
  });

  it('a try-on is refused without it', async () => {
    const s = await shopper();
    const res = await call('POST', '/api/tryon', s.token, { productId: 'x', photoRef: 'asset:cxxxxxxxxxxxxxxxxxxxxxxxx' });
    expect([403, 400]).toContain(res.status);
    if (res.status === 403) expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TRYON_CONSENT_REQUIRED');
  });

  it('withdrawing it deletes every try-on photo now and asks again next time', async () => {
    const s = await shopper();
    await call('POST', '/api/tryon/consent', s.token, { accepted: true });
    const { data } = (await (await upload(s.token)).json()) as { data: { items: { ref: string }[] } };
    await call('POST', '/api/tryon/photo', s.token, { photoRef: data.items[0]!.ref });
    await upload(s.token);

    const res = (await (await call('DELETE', '/api/tryon/consent', s.token)).json()) as { data: { photosDeleted: number } };
    expect(res.data.photosDeleted).toBe(2);
    expect(await prisma.asset.count({ where: { ownerId: s.id, purpose: 'TRYON_PHOTO', deletedAt: null } })).toBe(0);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: s.id } });
    expect(u).toMatchObject({ tryOnPhotoUrl: null, tryOnConsentAt: null, tryOnConsentVersion: null });
    expect((await upload(s.token)).status).toBe(403);
  });
});
