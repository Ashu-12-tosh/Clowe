import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import type { AdminSellerDetail, AdminSellerPage, SellerKycStatus } from '@clowe/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { seedFixture } from '../../test/fixture';
import { signAccessToken } from '../../utils/jwt';
import { kycProvider } from './index';

/**
 * Seller KYC end to end, on the mock provider: real Postgres, real routes,
 * real rate limiter.
 *
 * Every provider method is spied on, so the tests can count calls — and the
 * count is the point. A call is money: these pin that an answer is never
 * bought twice, that a retry only happens when someone asks for one, and that
 * a bank name match is only requested when there is a name to match.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let adminToken: string;
let seq = 0;

const DETAILS = {
  panNumber: 'ABCDE1234F',
  panName: 'Rahul Sharma',
  gstNumber: '29ABCDE1234F1Z5',
  bankAccountNo: '1234567890',
  bankIfsc: 'HDFC0001234',
  bankAccountName: 'Rahul Sharma',
};

beforeAll(async () => {
  await seedFixture(prisma);
  const admin = await prisma.user.create({
    data: { phone: '9100099999', name: 'KYC Admin', role: Role.ADMIN, referralCode: 'KYC-ADMIN' },
  });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** A fresh seller per test, so no test inherits another's checks or rate limit. */
async function makeSeller(fields: Partial<typeof DETAILS> = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `91000${String(seq).padStart(5, '0')}`,
      name: `KYC Seller ${seq}`,
      role: Role.SELLER,
      referralCode: `KYC-S-${seq}`,
    },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `KYC Shop ${seq}`, ...DETAILS, ...fields },
  });
  return { id: seller.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

async function http<T>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; data: T; error?: { code: string; warnings?: string[] } };
  return { status: res.status, json };
}

const verify = (token: string) => http<SellerKycStatus>('POST', '/api/seller/kyc/verify', token);
const detail = async (id: string) =>
  (await http<AdminSellerDetail>('GET', `/api/admin/sellers/${id}`, adminToken)).json.data;

function spies() {
  return {
    pan: vi.spyOn(kycProvider, 'verifyPAN'),
    gstin: vi.spyOn(kycProvider, 'verifyGSTIN'),
    bank: vi.spyOn(kycProvider, 'verifyBank'),
  };
}

// ---------------------------------------------------------------------------

describe('verifying', () => {
  it('checks PAN, GSTIN and bank, and stores the outcome — never the response', async () => {
    const s = await makeSeller();
    const { status, json } = await verify(s.token);
    expect(status).toBe(200);
    expect([json.data.pan.state, json.data.gstin.state, json.data.bank.state]).toEqual([
      'VERIFIED',
      'VERIFIED',
      'VERIFIED',
    ]);

    const rows = await prisma.sellerKycCheck.findMany({ where: { sellerId: s.id } });
    expect(rows.map((r) => r.kind).sort()).toEqual(['BANK', 'GSTIN', 'PAN']);
    for (const row of rows) {
      expect(row.provider).toBe('mock');
      expect(row.createdAt).toBeInstanceOf(Date);
    }
    const pan = rows.find((r) => r.kind === 'PAN')!;
    expect([pan.outcome, pan.nameScore, pan.nameBand]).toEqual(['VERIFIED', 100, 'DIRECT_MATCH']);
    // Fingerprints only: no PAN, account number or name in a verification row.
    const stored = JSON.stringify(rows);
    for (const secret of ['ABCDE1234F', '1234567890', 'HDFC0001234', 'Rahul']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('never pays twice for an answer', async () => {
    const s = await makeSeller();
    await verify(s.token);
    const calls = spies();
    await verify(s.token);
    expect([calls.pan, calls.gstin, calls.bank].map((c) => c.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('never re-verifies a PAN that passed, even after the name on file changes', async () => {
    const s = await makeSeller();
    await verify(s.token);
    await prisma.sellerProfile.update({ where: { id: s.id }, data: { panName: 'Rahul K Sharma' } });
    const calls = spies();
    await verify(s.token);
    expect(calls.pan).not.toHaveBeenCalled();
  });

  it('does not ask again after a definitive "no" — same details, same answer, same bill', async () => {
    const s = await makeSeller({ panNumber: 'ZZZZZ1234F', gstNumber: '' });
    expect((await verify(s.token)).json.data.pan.state).toBe('FAILED');
    const calls = spies();
    await verify(s.token);
    expect(calls.pan).not.toHaveBeenCalled();
  });

  it('caches nothing on no answer: the next deliberate run asks again', async () => {
    const s = await makeSeller({ panNumber: 'EEEEE1234F', gstNumber: '' });
    const first = await verify(s.token);
    expect(first.json.data.pan.state).toBe('ERROR');
    expect(first.json.data.canVerify).toBe(true);
    const calls = spies();
    await verify(s.token);
    expect(calls.pan).toHaveBeenCalledTimes(1);
  });

  it('never sends details that fail the format check', async () => {
    const s = await makeSeller({ panNumber: 'ABC123', gstNumber: '29ABC' });
    const calls = spies();
    const { json } = await verify(s.token);
    expect(json.data.pan.state).toBe('INVALID_FORMAT');
    expect(json.data.gstin.state).toBe('INVALID_FORMAT');
    expect(calls.pan).not.toHaveBeenCalled();
    expect(calls.gstin).not.toHaveBeenCalled();
  });

  it('does not pay for a PAN check with no name to match against', async () => {
    const s = await makeSeller({ panName: '' });
    const calls = spies();
    const { json } = await verify(s.token);
    expect(json.data.pan.state).toBe('NOT_RUN');
    expect(json.data.pan.reasonLabel).toBe('the name to check against is missing');
    expect(calls.pan).not.toHaveBeenCalled();
  });
});

describe('the bank account', () => {
  it('is re-verified when the account changes, and only then', async () => {
    const s = await makeSeller();
    await verify(s.token);

    let calls = spies();
    await verify(s.token);
    expect(calls.bank).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    await prisma.sellerProfile.update({ where: { id: s.id }, data: { bankAccountNo: '9876543210' } });
    calls = spies();
    await verify(s.token);
    expect(calls.bank).toHaveBeenCalledTimes(1);
  });

  it('asks for a name match only when there is a name to match', async () => {
    const s = await makeSeller({ bankAccountName: '' });
    const calls = spies();
    await verify(s.token);
    expect(calls.bank).toHaveBeenCalledWith('1234567890', 'HDFC0001234', null);
    expect((await detail(s.id)).kycApprovalWarnings).toContain(
      'Bank account is valid, but the account holder name was not checked.',
    );
  });

  it('is checked again, with the name, once a name appears — the match is what proves ownership', async () => {
    const s = await makeSeller({ bankAccountName: '' });
    await verify(s.token);
    await prisma.sellerProfile.update({ where: { id: s.id }, data: { bankAccountName: 'Rahul Sharma' } });
    const calls = spies();
    await verify(s.token);
    expect(calls.bank).toHaveBeenCalledWith('1234567890', 'HDFC0001234', 'Rahul Sharma');
    expect((await detail(s.id)).kyc.bank.nameScore).toBe(100);
  });
});

describe('GSTIN is optional', () => {
  it('is never checked when absent, and never blocks approval', async () => {
    const s = await makeSeller({ gstNumber: '' });
    const calls = spies();
    const { json } = await verify(s.token);
    expect(json.data.gstin.state).toBe('NOT_PROVIDED');
    expect(calls.gstin).not.toHaveBeenCalled();

    const d = await detail(s.id);
    expect(d.kycApprovalWarnings).toEqual([]);
    const approve = await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, { action: 'approve' });
    expect(approve.status).toBe(200);
  });
});

describe('fraud signals are surfaced, not buried', () => {
  it('a GSTIN carrying another PAN shows in the list and heads the detail', async () => {
    const s = await makeSeller({ panNumber: 'PQRST5678K', gstNumber: '29ABCDE1234F1Z5' });
    const d = await detail(s.id);
    expect(d.kyc.panGstinMismatch).toBe(true);
    expect(d.kycAlerts.panGstinMismatch).toBe(true);
    expect(d.kycApprovalWarnings[0]).toContain('PAN–GSTIN mismatch');
    expect(d.kycApprovalWarnings[0]).toContain('PQRST5678K');

    const list = await http<AdminSellerPage>('GET', '/api/admin/sellers?pageSize=100', adminToken);
    expect(list.json.data.rows.find((r) => r.id === s.id)?.kycAlerts.panGstinMismatch).toBe(true);
  });

  it("the provider's fraud flag on a bank account shows in the list and the detail", async () => {
    const s = await makeSeller({ bankAccountNo: '1234566666' });
    await verify(s.token);
    const d = await detail(s.id);
    expect(d.kyc.fraudAccount).toBe(true);
    expect(d.kycAlerts.fraudAccount).toBe(true);
    expect(d.kycApprovalWarnings).toContain('Bank account is flagged as fraudulent by the verification provider.');

    const list = await http<AdminSellerPage>('GET', '/api/admin/sellers?pageSize=100', adminToken);
    expect(list.json.data.rows.find((r) => r.id === s.id)?.kycAlerts.fraudAccount).toBe(true);
  });
});

describe('approval', () => {
  it('is refused with the plain list of problems until the admin acknowledges it', async () => {
    const s = await makeSeller({ panName: '' });
    await verify(s.token);

    const refused = await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, { action: 'approve' });
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code).toBe('KYC_WARNINGS_UNACKNOWLEDGED');
    expect(refused.json.error?.warnings).toEqual([
      'PAN has not been verified: the name to check against is missing.',
    ]);
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('PENDING');

    const approved = await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, {
      action: 'approve',
      acknowledgeKycWarnings: true,
    });
    expect(approved.status).toBe(200);
    // What was waved through is on record for the next admin.
    const note = await prisma.sellerNote.findFirstOrThrow({ where: { sellerId: s.id } });
    expect(note.body).toContain('Approved with KYC warnings acknowledged');
    expect(note.body).toContain('PAN has not been verified');
  });

  it('cannot be had by reinstating a rejected application instead', async () => {
    const s = await makeSeller({ panName: '' });
    await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, { action: 'reject', reason: 'Documents unclear' });
    const refused = await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, { action: 'reinstate' });
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code).toBe('KYC_WARNINGS_UNACKNOWLEDGED');
    const approved = await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, {
      action: 'reinstate',
      acknowledgeKycWarnings: true,
    });
    expect(approved.status).toBe(200);
  });

  it('is not asked again when a once-approved seller is reinstated after a suspension', async () => {
    const s = await makeSeller({ panName: '' });
    await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, {
      action: 'approve',
      acknowledgeKycWarnings: true,
    });
    await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, { action: 'suspend', reason: 'Late shipments' });
    const reinstated = await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, { action: 'reinstate' });
    expect(reinstated.status).toBe(200);
  });

  it('needs no acknowledgement when there is nothing to warn about', async () => {
    const s = await makeSeller();
    await verify(s.token);
    const approve = await http('PATCH', `/api/admin/sellers/${s.id}/status`, adminToken, { action: 'approve' });
    expect(approve.status).toBe(200);
    expect(await prisma.sellerNote.count({ where: { sellerId: s.id } })).toBe(0);
  });
});

describe('the name-match threshold', () => {
  it('moves without re-verifying anyone', async () => {
    const s = await makeSeller({ panName: 'Rahul MOCK MODERATE' }); // scores 70
    await verify(s.token);
    expect((await detail(s.id)).kyc.pan.nameMeetsThreshold).toBe(false); // default 85

    const calls = spies();
    await http('PUT', '/api/admin/settings', adminToken, { kycNameMatchMinScore: 60 });
    try {
      const d = await detail(s.id);
      expect(d.kyc.pan.nameMeetsThreshold).toBe(true);
      expect(d.kyc.nameMatchThreshold).toBe(60);
      expect(calls.pan).not.toHaveBeenCalled();
    } finally {
      await http('PUT', '/api/admin/settings', adminToken, { kycNameMatchMinScore: 85 });
    }
  });
});

describe('the seller-facing endpoint', () => {
  it('shows states and reasons, never scores or bands', async () => {
    const s = await makeSeller({ panName: 'Rahul MOCK POOR' });
    await verify(s.token);
    const { json } = await http<SellerKycStatus>('GET', '/api/seller/kyc', s.token);
    const text = JSON.stringify(json.data);
    expect(text).not.toContain('nameScore');
    expect(text).not.toContain('POOR_PARTIAL');
    expect(json.data.pan.nameNeedsReview).toBe(true);
  });

  it('is rate-limited per seller: five runs an hour', async () => {
    const s = await makeSeller();
    for (let i = 0; i < 5; i++) expect((await verify(s.token)).status).toBe(200);
    expect((await verify(s.token)).status).toBe(429);
    // Another seller is unaffected.
    const other = await makeSeller();
    expect((await verify(other.token)).status).toBe(200);
  });

  it('refuses a second run while one is in flight, instead of paying twice', async () => {
    const s = await makeSeller();
    await prisma.sellerProfile.update({ where: { id: s.id }, data: { kycCheckStartedAt: new Date() } });
    const calls = spies();
    const { status, json } = await verify(s.token);
    expect(status).toBe(409);
    expect(json.error?.code).toBe('KYC_CHECK_RUNNING');
    expect(calls.pan).not.toHaveBeenCalled();
  });

  it("takes over a crashed run's stale claim", async () => {
    const s = await makeSeller();
    await prisma.sellerProfile.update({
      where: { id: s.id },
      data: { kycCheckStartedAt: new Date(Date.now() - 3 * 60 * 1000) },
    });
    expect((await verify(s.token)).status).toBe(200);
  });
});

describe('providers', () => {
  it("do not inherit each other's answers — a mock 'verified' is not a real one", async () => {
    const s = await makeSeller();
    await verify(s.token);
    // As if these had come from a different provider than the one now live.
    await prisma.sellerKycCheck.updateMany({ where: { sellerId: s.id }, data: { provider: 'cashfree' } });

    const { json } = await http<SellerKycStatus>('GET', '/api/seller/kyc', s.token);
    expect(json.data.pan.state).toBe('NOT_RUN');
    const calls = spies();
    await verify(s.token);
    expect(calls.pan).toHaveBeenCalledTimes(1);
  });
});

describe('admin re-run', () => {
  it('asks again only for the check that had no answer', async () => {
    const s = await makeSeller({ bankAccountNo: '1234569999' }); // bank errors on the mock
    await verify(s.token);
    const calls = spies();
    const res = await http<{ kyc: { bank: { state: string } } }>(
      'POST',
      `/api/admin/sellers/${s.id}/kyc-checks`,
      adminToken,
      { check: 'BANK' },
    );
    expect(res.status).toBe(200);
    expect(calls.bank).toHaveBeenCalledTimes(1);
    expect(calls.pan).not.toHaveBeenCalled();
    expect(res.json.data.kyc.bank.state).toBe('ERROR');
  });
});
