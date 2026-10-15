import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { PrismaClient, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';
import { uploadDir } from './uploads';

/**
 * Public uploads are stored as WebP copies at 320/800/1600/2000 px wide —
 * never wider than the original — so no slot loads more than it needs.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;

async function upload(width: number, height: number, format: 'png' | 'jpeg' = 'jpeg') {
  const bytes = await sharp({ create: { width, height, channels: 3, background: '#b8860b' } })[format]().toBuffer();
  const form = new FormData();
  form.append('images', new Blob([bytes], { type: `image/${format}` }), `photo.${format === 'jpeg' ? 'jpg' : 'png'}`);
  const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, json: (await res.json()) as { data?: { urls: string[] }; error?: { code: string } } };
}

const fileOf = (url: string) => path.join(uploadDir, path.basename(new URL(url).pathname));

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { phone: '9196200001', name: 'Upload Seller', role: Role.SELLER, referralCode: 'UPLOAD-S' },
  });
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('a public image upload', () => {
  it('is stored as WebP copies up to its own width, and the URL names the largest', async () => {
    const res = await upload(1200, 1200);
    expect(res.status).toBe(200);
    const [url] = res.json.data!.urls;
    expect(url).toMatch(/-w1600\.webp$/);
    const stem = fileOf(url!).replace(/-w1600\.webp$/, '');
    for (const w of [320, 800, 1600]) expect(fs.existsSync(`${stem}-w${w}.webp`)).toBe(true);
    expect(fs.existsSync(`${stem}-w2000.webp`)).toBe(false);
    // The 1600 copy is the original's own 1200 px, not blown up; the 320 one is 320.
    expect((await sharp(`${stem}-w1600.webp`).metadata()).width).toBe(1200);
    expect((await sharp(`${stem}-w320.webp`).metadata())).toMatchObject({ width: 320, format: 'webp' });
    // The 5 MB original is not kept.
    expect(fs.readdirSync(uploadDir).some((f) => f.startsWith(path.basename(stem)) && !f.endsWith('.webp'))).toBe(false);
  });

  it('keeps a wide banner at 2000 and a small icon at its own size', async () => {
    const [wide] = (await upload(3000, 1125, 'png')).json.data!.urls;
    expect(wide).toMatch(/-w2000\.webp$/);
    expect((await sharp(fileOf(wide!)).metadata()).width).toBe(2000);
    const [small] = (await upload(200, 200)).json.data!.urls;
    expect(small).toMatch(/-w320\.webp$/);
    expect((await sharp(fileOf(small!)).metadata()).width).toBe(200);
  });

  it('still refuses a file that is not an image', async () => {
    const form = new FormData();
    form.append('images', new Blob([Buffer.from('not an image at all')], { type: 'image/png' }), 'x.png');
    const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    expect(res.status).toBe(400);
  });
});
