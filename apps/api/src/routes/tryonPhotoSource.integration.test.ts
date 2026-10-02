import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedFixture } from '../test/fixture';
import { env } from '../env';
import { signAccessToken } from '../utils/jwt';
import { BlockedUrlError, fetchPublic } from '../utils/publicFetch';
import { isOwnUpload } from './uploads';

/**
 * Try-on reads two images on the server: the shopper's photo and the
 * product's first image (a seller-supplied URL). Neither may become a way to
 * make this API fetch an address of the caller's choosing.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;

beforeAll(async () => {
  await seedFixture(prisma);
  const user = await prisma.user.create({ data: { phone: '9600000001', name: 'Photo Source', referralCode: 'PHOTO-SRC-1' } });
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

describe('the shopper photo must be one of our uploads', () => {
  it('knows our uploads from everything else', () => {
    expect(isOwnUpload(`${env.API_PUBLIC_URL}/uploads/1788258286334-9475b8956c4b.png`)).toBe(true);
    expect(isOwnUpload('/uploads/demo/abc123.jpg')).toBe(true);
    expect(isOwnUpload('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isOwnUpload(`${env.API_PUBLIC_URL}/uploads/../../etc/passwd`)).toBe(false);
    expect(isOwnUpload(`${env.API_PUBLIC_URL}/uploads/a.jpg?x=http://10.0.0.1`)).toBe(false);
    expect(isOwnUpload('https://evil.example/uploads/a.jpg')).toBe(false);
  });

  it('refuses to save another URL as the try-on photo', async () => {
    const res = await post('/api/tryon/photo', { photoUrl: 'http://169.254.169.254/latest/meta-data/' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PHOTO');
  });

  it('refuses to run a try-on with another URL', async () => {
    const res = await post('/api/tryon', { productId: 'any', photoUrl: 'http://10.0.0.1/admin.png' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PHOTO');
  });

  it('accepts an upload of ours', async () => {
    const res = await post('/api/tryon/photo', { photoUrl: `${env.API_PUBLIC_URL}/uploads/1788258286334-9475b8956c4b.png` });
    expect(res.status).toBe(200);
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
