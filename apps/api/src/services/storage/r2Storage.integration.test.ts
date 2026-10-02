import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIVATE_FILE_ORIGINS } from '@clowe/shared';
import { seedFixture } from '../../test/fixture';
import { TINY_PNG } from '../../test/images';
import { storePrivateFile } from '../assets';
import { localFiles } from './index';
import { R2StorageProvider } from './R2StorageProvider';
import { moveAssets } from '../../../prisma/moveAssets';

/**
 * R2 through its S3-compatible API, against an in-process S3 stand-in: it
 * stores objects in memory and does not check signatures, so this proves
 * what the provider sends and does with the answers, not that Cloudflare
 * accepts the signature. That needs a real bucket (see DEPLOY_RUNBOOK).
 */

const prisma = new PrismaClient();
let s3: Server;
let endpoint: string;
const objects = new Map<string, { body: Buffer; type: string }>();
const seen: string[] = [];

beforeAll(async () => {
  await seedFixture(prisma);
  s3 = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://s3');
    seen.push(`${req.method} ${url.pathname}`);
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = decodeURIComponent(url.pathname);
      if (req.method === 'HEAD' && (path === '/clowe-private' || path === '/clowe-private/')) {
        res.writeHead(200).end();
      } else if (req.method === 'PUT') {
        objects.set(path, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) });
        res.writeHead(200, { etag: '"x"' }).end();
      } else if (req.method === 'GET' && objects.has(path)) {
        const o = objects.get(path)!;
        res.writeHead(200, {
          'content-type': o.type,
          'content-length': o.body.length,
          'content-disposition': url.searchParams.get('response-content-disposition') ?? '',
        });
        res.end(o.body);
      } else if (req.method === 'DELETE') {
        objects.delete(path);
        res.writeHead(204).end();
      } else {
        res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
      }
    });
  });
  await new Promise<void>((resolve) => s3.listen(0, '127.0.0.1', () => resolve()));
  endpoint = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => s3.close(() => resolve()));
  await prisma.$disconnect();
});

const r2 = () =>
  new R2StorageProvider({ accountId: 'acct123', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', bucket: 'clowe-private', endpoint });

describe('R2StorageProvider', () => {
  const key = 'return-photo/2026/10/0123456789abcdef0123456789abcdef.png';

  it('puts, gets and deletes by key, in the one bucket', async () => {
    const store = r2();
    await store.put(key, TINY_PNG, 'image/png');
    expect(objects.get(`/clowe-private/${key}`)?.body.equals(TINY_PNG)).toBe(true);
    expect(objects.get(`/clowe-private/${key}`)?.type).toBe('image/png');
    expect((await store.get(key)).equals(TINY_PNG)).toBe(true);
    await store.delete(key);
    expect(objects.has(`/clowe-private/${key}`)).toBe(false);
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('refuses a malformed key before sending anything', async () => {
    const before = seen.length;
    await expect(r2().put('../escape.png', TINY_PNG, 'image/png')).rejects.toThrow('Bad storage key');
    expect(seen.length).toBe(before);
  });

  it('reports whether the bucket answers', async () => {
    expect((await r2().check()).ok).toBe(true);
    const wrong = new R2StorageProvider({ accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c', bucket: 'nope', endpoint });
    expect((await wrong.check()).ok).toBe(false);
  });

  it('signs a short-lived GET for the object, which serves it inline', async () => {
    const store = r2();
    await store.put(key, TINY_PNG, 'image/png');
    const url = new URL(await store.signedUrl(key, 300));
    expect(url.pathname).toBe(`/clowe-private/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('response-content-disposition')).toBe('inline');
    const res = await fetch(url);
    expect(Buffer.from(await res.arrayBuffer()).equals(TINY_PNG)).toBe(true);
  });

  it('signs URLs on the account endpoint host the page policy allows', async () => {
    const real = new R2StorageProvider({ accountId: 'acct123', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', bucket: 'clowe-private' });
    const host = new URL(await real.signedUrl(key, 300)).host;
    expect(host).toBe('acct123.r2.cloudflarestorage.com');
    // The CSP's img-src/media-src entry is a wildcard over that domain.
    const pattern = PRIVATE_FILE_ORIGINS[0].replace('https://*.', '');
    expect(host.endsWith(`.${pattern}`)).toBe(true);
  });
});

describe('moving stored files to R2', () => {
  it('copies, checks, repoints and removes the original; a second run has nothing to do', async () => {
    const stored = await storePrivateFile({ purpose: 'RETURN_PHOTO', ownerId: null, body: TINY_PNG, contentType: 'image/png' });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: stored.id } });
    expect(asset.provider).toBe('local');

    const dry = await moveAssets(r2(), false);
    expect(dry.moved).toBe(0);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: stored.id } })).provider).toBe('local');

    const done = await moveAssets(r2(), true);
    expect(done.moved).toBeGreaterThanOrEqual(1);
    const moved = await prisma.asset.findUniqueOrThrow({ where: { id: stored.id } });
    expect(moved.provider).toBe('r2');
    expect(objects.get(`/clowe-private/${asset.key}`)?.body.equals(TINY_PNG)).toBe(true);
    await expect(localFiles.get(asset.key)).rejects.toThrow();

    // Moved assets name R2 now, so a second run does not pick this one up.
    const again = await prisma.asset.findMany({ where: { deletedAt: null, provider: { not: 'r2' } }, select: { id: true } });
    expect(again.map((a) => a.id)).not.toContain(stored.id);
  });
});
