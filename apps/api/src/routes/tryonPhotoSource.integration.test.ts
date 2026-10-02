import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';
import { BlockedUrlError, fetchPublic } from '../utils/publicFetch';
import { TINY_PNG } from '../test/images';

/**
 * Try-on reads two images on the server: the shopper's photo and the
 * product's first image (a seller-supplied URL). Neither may become a way to
 * make this API fetch an address of the caller's choosing, and the photo must
 * be the shopper's own private upload.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  await seedFixture(prisma);
  const user = await prisma.user.create({ data: { phone: '9600000001', name: 'Photo Source', referralCode: 'PHOTO-SRC-1' } });
  const other = await prisma.user.create({ data: { phone: '9600000002', name: 'Someone Else', referralCode: 'PHOTO-SRC-2' } });
  userId = user.id;
  otherUserId = other.id;
  token = signAccessToken({ sub: user.id, role: 'CUSTOMER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A stored-file row, without bytes: enough for the ownership checks. */
async function assetRow(ownerId: string, purpose: 'TRYON_PHOTO' | 'RETURN_PHOTO') {
  const a = await prisma.asset.create({
    data: { provider: 'local', key: `test/${purpose.toLowerCase()}/${Math.random().toString(36).slice(2)}.png`, purpose, contentType: 'image/png', bytes: 1, ownerId },
  });
  return `asset:${a.id}`;
}

describe('the shopper photo must be their own private upload', () => {
  it('refuses a URL where the photo reference belongs', async () => {
    const res = await post('/api/tryon/photo', { photoRef: 'http://169.254.169.254/latest/meta-data/' });
    expect(res.status).toBe(400);
  });

  it("refuses someone else's photo", async () => {
    const res = await post('/api/tryon/photo', { photoRef: await assetRow(otherUserId, 'TRYON_PHOTO') });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_FILE');
  });

  it('refuses their own file uploaded for something else', async () => {
    const res = await post('/api/tryon/photo', { photoRef: await assetRow(userId, 'RETURN_PHOTO') });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_FILE');
  });

  it("refuses to run a try-on with someone else's photo", async () => {
    const res = await post('/api/tryon', { productId: 'any', photoRef: await assetRow(otherUserId, 'TRYON_PHOTO') });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_FILE');
  });

  it('accepts their own upload, and shows it back through a signed URL', async () => {
    const form = new FormData();
    form.append('purpose', 'TRYON_PHOTO');
    form.append('images', new Blob([TINY_PNG], { type: 'image/png' }), 'me.png');
    const up = await fetch(`${base}/api/uploads/private`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    const { data } = (await up.json()) as { data: { items: { ref: string; url: string }[] } };
    const res = await post('/api/tryon/photo', { photoRef: data.items[0].ref });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { data: { savedPhotoRef: string; savedPhotoUrl: string } };
    expect(saved.data.savedPhotoRef).toBe(data.items[0].ref);
    expect(saved.data.savedPhotoUrl).toContain('/api/files/local?');
  });
});

describe('fetchPublic checks every redirect hop again', () => {
  // A stand-in "public" server on loopback: the test allows 127.0.0.1 only,
  // and every other address stays refused, exactly as production treats
  // private ones.
  let origin: Server;
  let port: number;
  beforeAll(async () => {
    origin = http.createServer((req, res) => {
      if (req.url === '/image') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else if (req.url === '/to-private') {
        res.writeHead(302, { location: `http://127.0.0.2:${port}/secret` });
        res.end();
      } else if (req.url === '/to-image') {
        res.writeHead(302, { location: '/image' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()));
    port = (origin.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => origin.close(() => resolve())));

  const opts = () => ({
    timeoutMs: 2_000,
    maxBytes: 1024,
    extraPorts: [port],
    isAllowedAddress: (a: string) => a === '127.0.0.1',
  });

  it('follows a redirect that stays on allowed addresses', async () => {
    const body = await fetchPublic(`http://127.0.0.1:${port}/to-image`, opts());
    expect(body.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('refuses a redirect to a refused address', async () => {
    await expect(fetchPublic(`http://127.0.0.1:${port}/to-private`, opts())).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('refuses a name that resolves to a refused address', async () => {
    await expect(
      fetchPublic(`http://localhost:${port}/image`, { ...opts(), isAllowedAddress: () => false }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('stops at the size limit', async () => {
    await expect(fetchPublic(`http://127.0.0.1:${port}/image`, { ...opts(), maxBytes: 2 })).rejects.toThrow('too large');
  });
});
