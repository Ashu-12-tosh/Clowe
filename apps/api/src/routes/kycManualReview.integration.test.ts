import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import type { AdminKycReviewView, SellerKycStatus, SellerKycSummary, SellerPayoutOverview, SellerStoreSettings } from '@clowe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { decryptBankAccount } from '../services/bankAccountCrypto';
import { TEST_SELLER_ADDRESS } from '../test/fixture';
import { signAccessToken } from '../utils/jwt';

/**
 * No mock "verified": with the mock provider every PAN, GSTIN and bank check
 * waits for an admin, who verifies or rejects each against the documents
 * (who, when, how — audited). Payouts wait for all three. The seller enters
 * their own bank account, stored encrypted and shown masked.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let seller: { id: string; userId: string; token: string };
let cheque: string;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

async function uploadDoc(token: string): Promise<string> {
  const form = new FormData();
  form.append('document', new Blob([Buffer.from('%PDF-1.4\n%cancelled cheque\n')], { type: 'application/pdf' }), 'cheque.pdf');
  const res = await fetch(`${base}/api/uploads/seller-document`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return ((await res.json()) as { data: { ref: string } }).data.ref;
}

const audited = async (action: string, entityId: string) => {
  await new Promise((r) => setTimeout(r, 300)); // audit entries are written in the background
  return prisma.auditLog.count({ where: { action, entityId } });
};

beforeAll(async () => {
  const u = await prisma.user.create({ data: { phone: '9177700001', name: 'Review Seller', role: Role.SELLER, referralCode: 'KR-1' } });
  const s = await prisma.sellerProfile.create({
    data: {
      ...TEST_SELLER_ADDRESS,
      userId: u.id,
      shopName: 'Review Shop',
      status: SellerStatus.APPROVED,
      approvedAt: new Date(),
      kycStatus: 'VERIFIED', // as an admin had set by hand before this change
      panNumber: 'ABCDE1234F',
      panName: 'Review Seller',
      gstNumber: '29ABCDE1234F1Z5',
    },
  });
  seller = { id: s.id, userId: u.id, token: signAccessToken({ sub: u.id, role: 'SELLER' }) };
  const a = await prisma.user.create({ data: { phone: '9177700002', name: 'Asha Admin', role: Role.ADMIN, referralCode: 'KR-2' } });
  adminToken = signAccessToken({ sub: a.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cheque = await uploadDoc(seller.token);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the mock provider', () => {
  it('never verifies: every check waits for review, and there is nothing for the seller to run', async () => {
    const ran = await call<SellerKycStatus>('POST', '/api/seller/kyc/verify', seller.token);
    expect(ran.status).toBe(200);
    expect([ran.json.data.pan.state, ran.json.data.gstin.state]).toEqual(['PENDING_REVIEW', 'PENDING_REVIEW']);
    expect(ran.json.data.bank.state).toBe('NOT_PROVIDED');
    const status = (await call<SellerKycStatus>('GET', '/api/seller/kyc', seller.token)).json.data;
    expect(status).toMatchObject({ reviewMode: 'MANUAL', canVerify: false });
    // The mock's own answers are kept, and count for nothing.
    expect(await prisma.sellerKycCheck.count({ where: { sellerId: seller.id, provider: 'mock', outcome: 'VERIFIED' } })).toBeGreaterThan(0);
  });

  it('never verifies a payout account either', async () => {
    const added = await call<{ verified: boolean }>('POST', '/api/seller/payouts/methods', seller.token, {
      type: 'BANK', label: 'HDFC', accountName: 'Review Seller', accountNumber: '50100012345678', ifsc: 'HDFC0001234',
    });
    expect(added.status).toBe(200);
    expect(added.json.data.verified).toBe(false);
  });
});

describe('the seller’s bank account', () => {
  it('is checked as entered: the number twice, the IFSC shape, the cheque their own', async () => {
    const good = { accountName: 'Review Seller', accountNumber: '50100099887766', confirmAccountNumber: '50100099887766', ifsc: 'hdfc0001234', accountType: 'CURRENT', chequeDoc: cheque };
    expect((await call('PUT', '/api/seller/store/bank', seller.token, { ...good, confirmAccountNumber: '50100099887760' })).status).toBe(400);
    expect((await call('PUT', '/api/seller/store/bank', seller.token, { ...good, ifsc: 'HDFC1234' })).status).toBe(400);
    expect((await call('PUT', '/api/seller/store/bank', seller.token, { ...good, accountNumber: '12ab', confirmAccountNumber: '12ab' })).status).toBe(400);
    const otherUser = await prisma.user.create({ data: { phone: '9177700003', name: 'Other', role: Role.SELLER, referralCode: 'KR-3' } });
    await prisma.sellerProfile.create({ data: { userId: otherUser.id, shopName: 'Other Shop' } });
    const othersCheque = await uploadDoc(signAccessToken({ sub: otherUser.id, role: 'SELLER' }));
    expect((await call('PUT', '/api/seller/store/bank', seller.token, { ...good, chequeDoc: othersCheque })).json.error?.code).toBe('INVALID_FILE');

    const saved = await call<{ settings: SellerStoreSettings }>('PUT', '/api/seller/store/bank', seller.token, good);
    expect(saved.status).toBe(200);
    expect(saved.json.data.settings).toMatchObject({ bankAccountLast4: '7766', bankIfsc: 'HDFC0001234', bankAccountType: 'CURRENT', bankChequeOnFile: true });
    expect(JSON.stringify(saved.json.data)).not.toContain('50100099887766');
  });

  it('is stored encrypted, never in the clear, and waits for review', async () => {
    const row = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: seller.id } });
    expect(row.bankAccountNo).toBeNull();
    expect(row.bankAccountEnc).toMatch(/^v1:/);
    expect(row.bankAccountEnc).not.toContain('50100099887766');
    expect(decryptBankAccount(row.bankAccountEnc!)).toBe('50100099887766');
    const kyc = (await call<SellerKycStatus>('GET', '/api/seller/kyc', seller.token)).json.data;
    expect(kyc.bank.state).toBe('PENDING_REVIEW');
    // The hand-set "VERIFIED" no longer stands over unverified checks.
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: seller.id } })).kycStatus).toBe('UNDER_REVIEW');
  });
});

describe('manual review', () => {
  it('shows the admin the values as entered, the documents and the GST search, and logs the full number being shown', async () => {
    const r = await call<AdminKycReviewView>('GET', `/api/admin/sellers/${seller.id}/kyc-review`, adminToken);
    expect(r.status).toBe(200);
    expect(r.json.data.values).toMatchObject({ pan: 'ABCDE1234F', gstin: '29ABCDE1234F1Z5', bankAccountNumber: '50100099887766', bankIfsc: 'HDFC0001234' });
    expect(r.json.data.documents.map((d) => d.kind)).toContain('bankChequeDoc');
    expect(r.json.data.gstSearchUrl).toBe('https://services.gst.gov.in/services/searchtp');
    expect(await audited('Seller bank details viewed', seller.id)).toBeGreaterThanOrEqual(1);
  });

  it('opens a document only through a fresh, audited link', async () => {
    const viewed = await call<{ url: string }>('POST', `/api/admin/sellers/${seller.id}/documents/bankChequeDoc/view`, adminToken);
    expect(viewed.status).toBe(200);
    expect(viewed.json.data.url).toBeTruthy();
    expect(await audited('Seller document viewed', seller.id)).toBe(1);
    expect((await call('POST', `/api/admin/sellers/${seller.id}/documents/constitutionDoc/view`, adminToken)).json.error?.code).toBe('DOCUMENT_NOT_ON_FILE');
    expect((await call('POST', `/api/admin/sellers/${seller.id}/documents/bankChequeDoc/view`, seller.token)).status).toBe(403);
  });

  it('records who verified, when and how; a rejection needs a reason and tells the seller', async () => {
    const pan = await call<{ kyc: SellerKycSummary }>('POST', `/api/admin/sellers/${seller.id}/kyc-review`, adminToken, { check: 'PAN', decision: 'VERIFY' });
    expect(pan.json.data.kyc.pan).toMatchObject({ state: 'VERIFIED', method: 'MANUAL', decidedBy: 'Asha Admin' });
    expect(await audited('KYC PAN verified (manual)', seller.id)).toBe(1);
    expect((await call('POST', `/api/admin/sellers/${seller.id}/kyc-review`, adminToken, { check: 'GSTIN', decision: 'REJECT' })).status).toBe(400);
    const gst = await call<{ kyc: SellerKycSummary }>('POST', `/api/admin/sellers/${seller.id}/kyc-review`, adminToken, { check: 'GSTIN', decision: 'REJECT', reason: 'Not active on the GST portal' });
    expect(gst.json.data.kyc.gstin).toMatchObject({ state: 'REJECTED', rejectReason: 'Not active on the GST portal' });
    expect(await prisma.notification.findFirst({ where: { userId: seller.userId, type: 'SELLER_KYC_REVIEW', body: { contains: 'Not active on the GST portal' } } })).toBeTruthy();
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: seller.id } })).kycStatus).toBe('REJECTED');
    // The seller sees it too.
    expect((await call<SellerKycStatus>('GET', '/api/seller/kyc', seller.token)).json.data.gstin).toMatchObject({ state: 'REJECTED', rejectReason: 'Not active on the GST portal' });
  });

  it('keeps payouts on hold until PAN, GSTIN and bank account are all verified', async () => {
    const overview = (await call<SellerPayoutOverview>('GET', '/api/seller/payouts/overview', seller.token)).json.data;
    expect(overview.gstinBlock).toMatchObject({ code: 'GSTIN_NOT_VERIFIED' });
    expect(overview.bankBlock).toMatchObject({ code: 'BANK_NOT_VERIFIED', bankState: 'PENDING_REVIEW' });
    expect(overview.panBlock).toBeNull();
    // An admin cannot set the shop "Verified" over the open checks.
    const forced = await call('PATCH', `/api/admin/sellers/${seller.id}/kyc`, adminToken, { kycStatus: 'VERIFIED' });
    expect(forced.json.error?.code).toBe('KYC_CHECKS_PENDING');
  });

  it('all three verified: the shop is verified, and the bank account becomes its verified payout account', async () => {
    await call('POST', `/api/admin/sellers/${seller.id}/kyc-review`, adminToken, { check: 'GSTIN', decision: 'VERIFY' });
    const bank = await call<{ kyc: SellerKycSummary }>('POST', `/api/admin/sellers/${seller.id}/kyc-review`, adminToken, { check: 'BANK', decision: 'VERIFY' });
    expect(bank.json.data.kyc.bank.state).toBe('VERIFIED');
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: seller.id } })).kycStatus).toBe('VERIFIED');
    const method = await prisma.sellerPayoutMethod.findFirstOrThrow({ where: { sellerId: seller.id, accountLast4: '7766' } });
    expect(method).toMatchObject({ verified: true, isDefault: true, ifsc: 'HDFC0001234' });
    const overview = (await call<SellerPayoutOverview>('GET', '/api/seller/payouts/overview', seller.token)).json.data;
    expect([overview.gstinBlock, overview.panBlock, overview.bankBlock]).toEqual([null, null, null]);
    // A verified PAN is locked against change.
    expect((await call('PUT', '/api/seller/store/business', seller.token, { panNumber: 'PQRST5678K', panName: 'Review Seller' })).json.error?.code).toBe('KYC_LOCKED');
  });

  it('a new bank account needs a new review', async () => {
    await call('PUT', '/api/seller/store/bank', seller.token, {
      accountName: 'Review Seller', accountNumber: '50100011112222', confirmAccountNumber: '50100011112222', ifsc: 'ICIC0001234', accountType: 'SAVINGS', chequeDoc: cheque,
    });
    expect((await call<SellerKycStatus>('GET', '/api/seller/kyc', seller.token)).json.data.bank.state).toBe('PENDING_REVIEW');
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: seller.id } })).kycStatus).toBe('UNDER_REVIEW');
  });
});
