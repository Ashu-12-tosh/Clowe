import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VENDOR_TERMS_VERSION, type AdminSellerDetail, type SellerProfileInfo } from '@clowe/shared';
import { createApp } from '../app';
import { messagingProvider } from '../services/messaging';
import { completeApplication, sellerDocument } from '../test/sellerApplication';
import { signAccessToken } from '../utils/jwt';

/**
 * A seller's application (item 3 of the owner's decisions; Vendor Terms 2.1):
 *  - nothing is created without accepting the Vendor Terms, and the
 *    acceptance (version, time, IP, browser) is kept;
 *  - the constitution document, cancelled cheque and signatory KYC come with
 *    it (brand authorisation optional), each the applicant's own upload;
 *  - the seller is told the application number by SMS; admins are told;
 *  - an admin can ask for more ("Needs more info"), and the seller answers;
 *  - a seller who has not accepted the current Vendor Terms is asked to.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let seq = 0;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

async function applicant() {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `91961${String(seq).padStart(5, '0')}`, name: `Applicant ${seq}`, referralCode: `APP-${seq}` } });
  return { userId: user.id, token: signAccessToken({ sub: user.id, role: 'CUSTOMER' }) };
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { phone: '9196099999', name: 'Application Admin', role: Role.ADMIN, referralCode: 'APP-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('submitting an application', () => {
  it('is refused without accepting the Vendor Terms, or with an old version, and creates nothing', async () => {
    const a = await applicant();
    const body = await completeApplication(prisma, a.userId, 'Unaccepted Shop');
    const none = await call('POST', '/api/seller/register', a.token, { ...body, acceptVendorTerms: false });
    expect(none.json.error?.code).toBe('VENDOR_TERMS_REQUIRED');
    const old = await call('POST', '/api/seller/register', a.token, { ...body, vendorTermsVersion: '2020-01-01' });
    expect(old.json.error?.code).toBe('VENDOR_TERMS_OUTDATED');
    expect(await prisma.sellerProfile.count({ where: { userId: a.userId } })).toBe(0);
  });

  it('needs the 2.1 documents, each the applicant’s own', async () => {
    const a = await applicant();
    const body = await completeApplication(prisma, a.userId, 'Docless Shop');
    expect((await call('POST', '/api/seller/register', a.token, { ...body, signatoryKycDoc: undefined })).status).toBe(400);
    const other = await applicant();
    const stolen = await call('POST', '/api/seller/register', a.token, { ...body, constitutionDoc: await sellerDocument(prisma, other.userId) });
    expect(stolen.status).not.toBe(200);
    const noBank = await call('POST', '/api/seller/register', a.token, { ...body, bankAccountNo: '' });
    expect(noBank.status).toBe(400);
    expect(await prisma.sellerProfile.count({ where: { userId: a.userId } })).toBe(0);
  });

  it('records the acceptance and the documents, and sends the application number', async () => {
    const sent = vi.spyOn(messagingProvider, 'send');
    const a = await applicant();
    const body = await completeApplication(prisma, a.userId, 'Accepted Shop');
    const res = await call<SellerProfileInfo>('POST', '/api/seller/register', a.token, body, { 'user-agent': 'ApplicationTest/1.0' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'PENDING', vendorTermsCurrent: true, infoRequest: null });
    expect(res.json.data.applicationId).toMatch(/^SA-[A-Z0-9]{8}$/);
    const p = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: a.userId }, include: { termsAcceptances: true } });
    expect(p).toMatchObject({ constitutionDoc: body.constitutionDoc, cancelledChequeDoc: body.cancelledChequeDoc, signatoryKycDoc: body.signatoryKycDoc, vendorTermsVersion: VENDOR_TERMS_VERSION });
    expect(p.termsAcceptances).toHaveLength(1);
    expect(p.termsAcceptances[0]).toMatchObject({ version: VENDOR_TERMS_VERSION, userAgent: 'ApplicationTest/1.0' });
    expect(p.termsAcceptances[0]!.ip).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.mock.calls.some(([m]) => m.channel === 'sms' && m.body.includes(res.json.data.applicationId))).toBe(true);
    sent.mockRestore();
    expect(await prisma.notification.count({ where: { type: 'SELLER_APPLICATION', title: { contains: res.json.data.applicationId } } })).toBeGreaterThan(0);

    const admin = (await call<AdminSellerDetail>('GET', `/api/admin/sellers/${p.id}`, adminToken)).json.data;
    expect(admin.application.applicationId).toBe(res.json.data.applicationId);
    // On file, but never as a link here: each opens through the audited view endpoint.
    expect(admin.application.documents.filter((d) => d.onFile).map((d) => d.key)).toEqual(['constitutionDoc', 'cancelledChequeDoc', 'signatoryKycDoc']);
    expect(admin.application.documents.every((d) => d.url === null)).toBe(true);
    expect(admin.application.termsAcceptances[0]?.version).toBe(VENDOR_TERMS_VERSION);
  });
});

describe('needs more info', () => {
  it('is asked by an admin and answered by the seller', async () => {
    const a = await applicant();
    await call('POST', '/api/seller/register', a.token, await completeApplication(prisma, a.userId, 'Info Shop'));
    const p = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: a.userId } });
    const asked = await call('POST', `/api/admin/sellers/${p.id}/request-info`, adminToken, { message: 'The cancelled cheque is not readable — please upload it again.' });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const sellerToken = signAccessToken({ sub: a.userId, role: 'SELLER' });
    const profile = (await call<SellerProfileInfo>('GET', '/api/seller/profile', sellerToken)).json.data;
    expect(profile.infoRequest).toContain('cancelled cheque');

    expect((await call('POST', '/api/seller/application', sellerToken, {})).json.error?.code).toBe('NOTHING_SENT');
    const fresh = await sellerDocument(prisma, a.userId);
    const answered = await call<SellerProfileInfo>('POST', '/api/seller/application', sellerToken, { cancelledChequeDoc: fresh, note: 'New photo attached' });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    expect(answered.json.data.infoRequest).toBeNull();
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: p.id } })).cancelledChequeDoc).toBe(fresh);
  });

  it('cannot be asked of a seller already decided', async () => {
    const a = await applicant();
    await call('POST', '/api/seller/register', a.token, await completeApplication(prisma, a.userId, 'Decided Shop'));
    const p = await prisma.sellerProfile.update({ where: { userId: a.userId }, data: { status: SellerStatus.APPROVED, approvedAt: new Date() } });
    expect((await call('POST', `/api/admin/sellers/${p.id}/request-info`, adminToken, { message: 'Anything else please' })).json.error?.code).toBe('NOT_PENDING');
  });
});

describe('a seller from before the Vendor Terms', () => {
  it('is asked to accept them, and the acceptance is kept', async () => {
    seq += 1;
    const user = await prisma.user.create({ data: { phone: `91961${String(seq).padStart(5, '0')}`, name: 'nitin', role: Role.SELLER, referralCode: `APP-${seq}` } });
    await prisma.sellerProfile.create({ data: { userId: user.id, shopName: 'Old Shop', slug: 'old-shop-app', status: SellerStatus.APPROVED, approvedAt: new Date() } });
    const token = signAccessToken({ sub: user.id, role: 'SELLER' });
    expect((await call<SellerProfileInfo>('GET', '/api/seller/profile', token)).json.data.vendorTermsCurrent).toBe(false);
    expect((await call('POST', '/api/seller/terms/accept', token, { version: '2020-01-01' })).json.error?.code).toBe('VENDOR_TERMS_OUTDATED');
    const ok = await call<SellerProfileInfo>('POST', '/api/seller/terms/accept', token, { version: VENDOR_TERMS_VERSION });
    expect(ok.json.data.vendorTermsCurrent).toBe(true);
    expect(await prisma.sellerTermsAcceptance.count({ where: { seller: { userId: user.id }, version: VENDOR_TERMS_VERSION } })).toBe(1);
  });
});

describe('the document upload', () => {
  it('takes a PDF or a photo, and refuses anything else', async () => {
    const a = await applicant();
    const send = async (bytes: Buffer, type: string, name: string) => {
      const form = new FormData();
      form.append('document', new Blob([bytes], { type }), name);
      const res = await fetch(`${base}/api/uploads/seller-document`, { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: form });
      return { status: res.status, json: (await res.json()) as { data?: { ref: string }; error?: { code: string } } };
    };
    const pdf = await send(Buffer.from('%PDF-1.4\n%test\n'), 'application/pdf', 'deed.pdf');
    expect(pdf.status, JSON.stringify(pdf.json)).toBe(200);
    expect(pdf.json.data?.ref).toMatch(/^asset:/);
    const fake = await send(Buffer.from('not a pdf at all'), 'application/pdf', 'fake.pdf');
    expect(fake.json.error?.code).toBe('INVALID_FILE_CONTENT');
  });
});
