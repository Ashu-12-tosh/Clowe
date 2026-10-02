import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { TINY_PNG } from '../test/images';
import { env } from '../env';
import { signAccessToken } from '../utils/jwt';
import { resolveFileUrls, storePrivateFile } from '../services/assets';
import { localFiles } from '../services/storage';
import { signLocalFile } from '../services/storage/LocalStorageProvider';
import { sweepExpiredTryOnPhotos, TRYON_PHOTO_RETENTION_DAYS } from '../services/tryonPhotoRetention';
import { uploadDir } from './uploads';
import { backfillPrivateFiles } from '../../prisma/backfillPrivateFiles';

/**
 * Private files — return photos, try-on photos and results, packing videos —
 * never sit in the public uploads folder, are reachable only by a signed,
 * expiring link, and can only be attached by the user who uploaded them.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let buyer: { id: string; token: string };
let other: { id: string; token: string };
let seller: { id: string; token: string };

async function user(phone: string, role: Role = Role.CUSTOMER) {
  const u = await prisma.user.create({ data: { phone, name: `PF ${phone}`, role, referralCode: `PF-${phone}` } });
  return { id: u.id, token: signAccessToken({ sub: u.id, role }) };
}

beforeAll(async () => {
  await seedFixture(prisma);
  buyer = await user('9800000001');
  other = await user('9800000002');
  seller = await user('9800000003', Role.SELLER);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** Fetch a signed URL against the test server, whatever host API_PUBLIC_URL names. */
const local = (url: string) => {
  const u = new URL(url);
  return fetch(`${base}${u.pathname}${u.search}`);
};

async function uploadPrivate(token: string, purpose: string, bytes: Buffer = TINY_PNG) {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('images', new Blob([bytes], { type: 'image/png' }), 'photo.png');
  return fetch(`${base}/api/uploads/private`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
}

describe('uploading and viewing a private photo', () => {
  let ref: string;
  let url: string;

  it('stores it privately and returns a reference and a preview URL', async () => {
    const publicBefore = await fs.readdir(uploadDir);
    const res = await uploadPrivate(buyer.token, 'RETURN_PHOTO');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { items: { ref: string; url: string }[] } };
    ({ ref, url } = data.items[0]);
    expect(ref).toMatch(/^asset:c[a-z0-9]+$/);
    expect(url).toContain('/api/files/local?');
    // Nothing landed in the folder that is served to anyone.
    expect(await fs.readdir(uploadDir)).toEqual(publicBefore);
  });

  it('serves the bytes for a signed link, sandboxed', async () => {
    const res = await local(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cache-control')).toMatch(/^private/);
    expect(Buffer.from(await res.arrayBuffer()).equals(TINY_PNG)).toBe(true);
  });

  it('refuses a tampered, expired or malformed link', async () => {
    const u = new URL(url);
    const key = u.searchParams.get('k')!;
    const tampered = new URL(u);
    tampered.searchParams.set('s', `${u.searchParams.get('s')!.slice(0, -2)}xx`);
    expect((await local(tampered.toString())).status).toBe(403);

    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = new URL(u);
    expired.searchParams.set('e', String(past));
    expired.searchParams.set('s', signLocalFile(key, past));
    expect((await local(expired.toString())).status).toBe(403);

    const traversal = new URL(u);
    traversal.searchParams.set('k', '../uploads/x.png');
    expect((await local(traversal.toString())).status).toBe(403);
  });

  it('refuses a missing purpose, a fake image, and anonymous uploads', async () => {
    expect(((await (await uploadPrivate(buyer.token, 'AVATAR')).json()) as { error: { code: string } }).error.code).toBe('INVALID_PURPOSE');
    const fake = await uploadPrivate(buyer.token, 'RETURN_PHOTO', Buffer.from('<svg onload=alert(1)>'));
    expect(fake.status).toBe(400);
    const anonymous = await fetch(`${base}/api/uploads/private`, { method: 'POST', body: new FormData() });
    expect(anonymous.status).toBe(401);
  });

  it("will not attach someone else's photo to a return", async () => {
    const res = await fetch(`${base}/api/orders/items/any-item/return`, {
      method: 'POST',
      headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'DAMAGED', photos: [ref] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_FILE');
  });
});

describe('packing videos', () => {
  // The start of an MP4: a box size, then "ftyp".
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
  const send = (token: string) => {
    const form = new FormData();
    form.append('video', new Blob([mp4], { type: 'video/mp4' }), 'pack.mp4');
    return fetch(`${base}/api/uploads/video`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  };

  it('are for sellers only', async () => {
    expect((await send(buyer.token)).status).toBe(403);
  });

  it('come back as a private reference', async () => {
    const res = await send(seller.token);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { ref: string; url: string } };
    expect(data.ref).toMatch(/^asset:/);
    expect((await local(data.url)).headers.get('content-type')).toBe('video/mp4');
  });
});

describe('resolving stored values', () => {
  it('signs references, passes other values through, and returns null once a file is gone', async () => {
    const live = await storePrivateFile({ purpose: 'TRYON_RESULT', ownerId: buyer.id, body: TINY_PNG, contentType: 'image/png' });
    const gone = await storePrivateFile({ purpose: 'TRYON_RESULT', ownerId: buyer.id, body: TINY_PNG, contentType: 'image/png' });
    await prisma.asset.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const demo = 'https://picsum.photos/seed/x/400/600';
    const [a, b, c, d] = await resolveFileUrls([live.ref, demo, gone.ref, null]);
    expect(a).toContain('/api/files/local?');
    expect(b).toBe(demo);
    expect(c).toBeNull();
    expect(d).toBeNull();
  });
});

describe('try-on photo retention', () => {
  it('deletes unsaved photos past retention, keeps saved and recent ones, and never touches rows that are not ours', async () => {
    const old = new Date(Date.now() - (TRYON_PHOTO_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    const expired = await storePrivateFile({ purpose: 'TRYON_PHOTO', ownerId: buyer.id, body: TINY_PNG, contentType: 'image/png' });
    const saved = await storePrivateFile({ purpose: 'TRYON_PHOTO', ownerId: other.id, body: TINY_PNG, contentType: 'image/png' });
    const recent = await storePrivateFile({ purpose: 'TRYON_PHOTO', ownerId: buyer.id, body: TINY_PNG, contentType: 'image/png' });
    // Its bytes already gone: the sweep must carry on regardless.
    const fileless = await storePrivateFile({ purpose: 'TRYON_PHOTO', ownerId: buyer.id, body: TINY_PNG, contentType: 'image/png' });
    await prisma.asset.updateMany({ where: { id: { in: [expired.id, saved.id, fileless.id] } }, data: { createdAt: old } });
    await prisma.user.update({ where: { id: other.id }, data: { tryOnPhotoUrl: saved.ref } });
    const filelessRow = await prisma.asset.findUniqueOrThrow({ where: { id: fileless.id } });
    await localFiles.delete(filelessRow.key);
    const product = await prisma.product.findFirstOrThrow();
    const demoRow = await prisma.tryOnHistory.create({
      data: { userId: buyer.id, productId: product.id, inputImageUrl: 'https://picsum.photos/seed/demo/400/600', provider: 'mock', status: 'SUCCESS' },
    });

    expect(await sweepExpiredTryOnPhotos()).toBe(2);

    const after = await prisma.asset.findMany({ where: { id: { in: [expired.id, saved.id, recent.id, fileless.id] } } });
    const byId = new Map(after.map((a) => [a.id, a]));
    expect(byId.get(expired.id)!.deletedAt).not.toBeNull();
    expect(byId.get(fileless.id)!.deletedAt).not.toBeNull();
    expect(byId.get(saved.id)!.deletedAt).toBeNull();
    expect(byId.get(recent.id)!.deletedAt).toBeNull();
    await expect(localFiles.get(byId.get(expired.id)!.key)).rejects.toThrow();
    expect((await prisma.tryOnHistory.findUniqueOrThrow({ where: { id: demoRow.id } })).inputImageUrl).toBe(
      'https://picsum.photos/seed/demo/400/600',
    );
    // And again: nothing left to do.
    expect(await sweepExpiredTryOnPhotos()).toBe(0);
  });
});

describe('moving files from before private storage', () => {
  it('moves a public upload into private storage and rewrites every row that used it, once', async () => {
    const name = '1790000000000-abcdef123456.png';
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, name), TINY_PNG);
    const legacy = `${env.API_PUBLIC_URL}/uploads/${name}`;
    await prisma.user.update({ where: { id: buyer.id }, data: { tryOnPhotoUrl: legacy } });
    const product = await prisma.product.findFirstOrThrow();
    const used = await prisma.tryOnHistory.create({
      data: { userId: buyer.id, productId: product.id, inputImageUrl: legacy, provider: 'mock', status: 'SUCCESS' },
    });
    const demo = await prisma.tryOnHistory.create({
      data: { userId: buyer.id, productId: product.id, inputImageUrl: '/uploads/demo/model-1.jpg', provider: 'mock', status: 'SUCCESS' },
    });

    const dry = await backfillPrivateFiles(false);
    expect(dry.moved).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).tryOnPhotoUrl).toBe(legacy);

    await backfillPrivateFiles(true);
    const ref = (await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).tryOnPhotoUrl!;
    expect(ref).toMatch(/^asset:/);
    expect((await prisma.tryOnHistory.findUniqueOrThrow({ where: { id: used.id } })).inputImageUrl).toBe(ref);
    expect((await prisma.tryOnHistory.findUniqueOrThrow({ where: { id: demo.id } })).inputImageUrl).toBe('/uploads/demo/model-1.jpg');
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: ref.slice('asset:'.length) } });
    expect(asset).toMatchObject({ ownerId: buyer.id, purpose: 'TRYON_PHOTO' });
    expect((await localFiles.get(asset.key)).equals(TINY_PNG)).toBe(true);
    await expect(fs.access(path.join(uploadDir, name))).rejects.toThrow();

    // Run again: the rows now hold references, and are left alone.
    const again = await backfillPrivateFiles(true);
    expect(again.moved).toBe(0);
  });
});
