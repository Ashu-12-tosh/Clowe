import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role } from '@prisma/client';
import type { AdminSellerDetail, AdminSellerPage, KycCheckType, SellerKycStatus, SellerKycSummary } from '@clowe/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { seedFixture } from '../../test/fixture';
import { signAccessToken } from '../../utils/jwt';
import { kycProvider } from './index';
import { sellerDocument } from '../../test/sellerApplication';

/**
 * Seller KYC end to end, with the mock standing in for a real provider (under
 * another name: a mock answer itself never verifies — kycManualReview tests
 * that): real Postgres, real routes, real rate limiter.
 *
 * Every provider method is spied on, so the tests can count calls — and the
 * count is the point. A call is money: these pin that only an admin's press
 * ever makes one (one document per press), that an answer is never bought
 * twice, and that an answer verifies nothing until an admin marks it — and
 * the admin can only mark what the provider verified.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let seq = 0;

const DETAILS = {
  panNumber: 'ABCDE1234F',
  panName: 'Rahul Sharma',
  gstNumber: '29ABCDE1234F1Z5',
  bankAccountNo: '1234567890',
  bankIfsc: 'HDFC0001234',
  bankAccountName: 'Rahul Sharma',
};

const realName = kycProvider.name;
beforeAll(async () => {
  // The provider's rules (never pay twice, retries on demand, name matches)
  // are what these tests pin, so the mock answers as a real provider would.
  Object.defineProperty(kycProvider, 'name', { value: 'standin', configurable: true, writable: true });
  await seedFixture(prisma);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  Object.defineProperty(kycProvider, 'name', { value: realName, configurable: true, writable: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/**
 * A fresh seller per test, with its own admin, so no test inherits another's
 * checks or rate limit.
 */
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
  const admin = await prisma.user.create({
    data: { phone: `91099${String(seq).padStart(5, '0')}`, name: `KYC Admin ${seq}`, role: Role.ADMIN, referralCode: `KYC-A-${seq}` },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: `KYC Shop ${seq}`, ...DETAILS, ...fields },
  });
  return {
    id: seller.id,
    userId: user.id,
    token: signAccessToken({ sub: user.id, role: 'SELLER' }),
    admin: signAccessToken({ sub: admin.id, role: 'ADMIN' }),
  };
}
type Seller = Awaited<ReturnType<typeof makeSeller>>;

async function http<T>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; data: T; error?: { code: string; message: string; warnings?: string[] } };
  return { status: res.status, json };
}

/** The admin's "Verify with Cashfree" for one document. */
const providerCheck = (s: Seller, check: KycCheckType) =>
  http<{ kyc: SellerKycSummary; called: boolean }>('POST', `/api/admin/sellers/${s.id}/kyc-checks`, s.admin, { check });
/** The admin's "Mark verified" / "Reject". */
const decide = (s: Seller, check: KycCheckType, decision: 'VERIFY' | 'REJECT', reason?: string) =>
  http<{ kyc: SellerKycSummary }>('POST', `/api/admin/sellers/${s.id}/kyc-review`, s.admin, { check, decision, reason });
const detail = async (s: Seller) => (await http<AdminSellerDetail>('GET', `/api/admin/sellers/${s.id}`, s.admin)).json.data;
const sellerView = async (s: Seller) => (await http<SellerKycStatus>('GET', '/api/seller/kyc', s.token)).json.data;

/** Every document checked with the provider and marked verified by the admin. */
async function verifyAll(s: Seller) {
  for (const check of ['PAN', 'GSTIN', 'BANK'] as const) {
    expect((await providerCheck(s, check)).status).toBe(200);
    expect((await decide(s, check, 'VERIFY')).status).toBe(200);
  }
}

function spies() {
  return {
    pan: vi.spyOn(kycProvider, 'verifyPAN'),
    gstin: vi.spyOn(kycProvider, 'verifyGSTIN'),
    bank: vi.spyOn(kycProvider, 'verifyBank'),
  };
}
const callCounts = (c: ReturnType<typeof spies>) => [c.pan, c.gstin, c.bank].map((x) => x.mock.calls.length);

// ---------------------------------------------------------------------------

describe('only an admin’s press calls the provider', () => {
  it('one document per press, and the answer is stored — never the response', async () => {
    const s = await makeSeller();
    const calls = spies();
    const res = await providerCheck(s, 'PAN');
    expect(res.status).toBe(200);
    expect(res.json.data.called).toBe(true);
    expect(callCounts(calls)).toEqual([1, 0, 0]);

    const rows = await prisma.sellerKycCheck.findMany({ where: { sellerId: s.id } });
    expect(rows).toHaveLength(1);
    expect([rows[0].kind, rows[0].provider, rows[0].outcome, rows[0].nameScore, rows[0].nameBand]).toEqual(['PAN', 'standin', 'VERIFIED', 100, 'DIRECT_MATCH']);
    // Fingerprints only: no PAN, account number or name in a verification row.
    const stored = JSON.stringify(rows);
    for (const secret of ['ABCDE1234F', '1234567890', 'HDFC0001234', 'Rahul']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('a check is one press: refused without naming the document', async () => {
    const s = await makeSeller();
    const calls = spies();
    const res = await http('POST', `/api/admin/sellers/${s.id}/kyc-checks`, s.admin, {});
    expect(res.status).toBe(400);
    expect(callCounts(calls)).toEqual([0, 0, 0]);
  });

  it('keeps the provider’s reference id, and shows it with the name match', async () => {
    const s = await makeSeller();
    vi.spyOn(kycProvider, 'verifyPAN').mockResolvedValueOnce({ status: 'VERIFIED', reason: null, nameMatch: { score: 92, band: 'GOOD_PARTIAL_MATCH' }, referenceId: '881234' });
    const { json } = await providerCheck(s, 'PAN');
    expect(json.data.kyc.pan.providerCheck).toMatchObject({ outcome: 'VERIFIED', nameScore: 92, nameBand: 'GOOD_PARTIAL_MATCH', nameMeetsThreshold: true, referenceId: '881234', provider: 'standin' });
    expect((await prisma.sellerKycCheck.findFirstOrThrow({ where: { sellerId: s.id } })).providerRef).toBe('881234');
  });

  it('never from the seller: their button only reads, and is not offered', async () => {
    const s = await makeSeller();
    const calls = spies();
    const ran = await http<SellerKycStatus>('POST', '/api/seller/kyc/verify', s.token);
    expect(ran.status).toBe(200);
    expect(ran.json.data.canVerify).toBe(false);
    expect([ran.json.data.pan.state, ran.json.data.gstin.state, ran.json.data.bank.state]).toEqual(['PENDING_REVIEW', 'PENDING_REVIEW', 'PENDING_REVIEW']);
    expect(callCounts(calls)).toEqual([0, 0, 0]);
    expect(await prisma.sellerKycCheck.count({ where: { sellerId: s.id } })).toBe(0);
  });

  it('never from the seller’s own edits: a new bank account or PAN is left for the admin', async () => {
    const s = await makeSeller();
    const calls = spies();
    const bank = await http('PUT', '/api/seller/store/bank', s.token, {
      accountName: 'Rahul Sharma',
      accountNumber: '9988776655',
      confirmAccountNumber: '9988776655',
      ifsc: 'ICIC0000123',
      accountType: 'SAVINGS',
      chequeDoc: await sellerDocument(prisma, s.userId),
    });
    expect(bank.status).toBe(200);
    // Long enough for a background call to have landed, had one been started.
    await new Promise((r) => setTimeout(r, 300));
    expect(callCounts(calls)).toEqual([0, 0, 0]);
    expect(await prisma.sellerKycCheck.count({ where: { sellerId: s.id } })).toBe(0);
  });

  it('is refused while no real provider is connected: an admin checks the documents by hand', async () => {
    const s = await makeSeller();
    Object.defineProperty(kycProvider, 'name', { value: 'mock', configurable: true, writable: true });
    try {
      const calls = spies();
      const res = await providerCheck(s, 'PAN');
      expect(res.status).toBe(400);
      expect(res.json.error?.code).toBe('NO_VERIFICATION_PROVIDER');
      expect(callCounts(calls)).toEqual([0, 0, 0]);
    } finally {
      Object.defineProperty(kycProvider, 'name', { value: 'standin', configurable: true, writable: true });
    }
  });
});

describe('never paying twice', () => {
  it('a stored answer is reused instead of calling again', async () => {
    const s = await makeSeller();
    await providerCheck(s, 'GSTIN');
    const calls = spies();
    const again = await providerCheck(s, 'GSTIN');
    expect(again.json.data.called).toBe(false);
    expect(again.json.data.kyc.gstin.providerCheck?.outcome).toBe('VERIFIED');
    expect(callCounts(calls)).toEqual([0, 0, 0]);
  });

  it('a PAN that passed is not checked again, even after the name on file changes', async () => {
    const s = await makeSeller();
    await providerCheck(s, 'PAN');
    await prisma.sellerProfile.update({ where: { id: s.id }, data: { panName: 'Rahul K Sharma' } });
    const calls = spies();
    await providerCheck(s, 'PAN');
    expect(calls.pan).not.toHaveBeenCalled();
  });

  it('a definitive "no" is not asked again — same details, same answer, same bill', async () => {
    const s = await makeSeller({ panNumber: 'ZZZZZ1234F', gstNumber: '' });
    expect((await providerCheck(s, 'PAN')).json.data.kyc.pan.providerCheck?.outcome).toBe('FAILED');
    const calls = spies();
    await providerCheck(s, 'PAN');
    expect(calls.pan).not.toHaveBeenCalled();
  });

  it('no answer caches nothing, and nothing retries it: only the admin’s next press asks again, once', async () => {
    const s = await makeSeller({ panNumber: 'EEEEE1234F', gstNumber: '' });
    const calls = spies();
    const first = await providerCheck(s, 'PAN');
    expect(first.json.data.kyc.pan.providerCheck?.outcome).toBe('ERROR');
    expect(calls.pan).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.pan).toHaveBeenCalledTimes(1);
    await providerCheck(s, 'PAN');
    expect(calls.pan).toHaveBeenCalledTimes(2);
  });

  it('details that fail the format check are never sent', async () => {
    const s = await makeSeller({ panNumber: 'ABC123', gstNumber: '29ABC' });
    const calls = spies();
    const { json } = await providerCheck(s, 'PAN');
    expect(json.data.called).toBe(false);
    expect(json.data.kyc.pan.state).toBe('INVALID_FORMAT');
    await providerCheck(s, 'GSTIN');
    expect(callCounts(calls)).toEqual([0, 0, 0]);
  });

  it('a PAN with no name to match against is not paid for', async () => {
    const s = await makeSeller({ panName: '' });
    const calls = spies();
    const { json } = await providerCheck(s, 'PAN');
    expect(json.data.called).toBe(false);
    expect(json.data.kyc.pan.reason).toBe('NAME_MISSING');
    expect(json.data.kyc.pan.canMarkVerified).toBe(false);
    expect(calls.pan).not.toHaveBeenCalled();
  });

  it('a second press while one is in flight is refused instead of paying twice', async () => {
    const s = await makeSeller();
    await prisma.sellerProfile.update({ where: { id: s.id }, data: { kycCheckStartedAt: new Date() } });
    const calls = spies();
    const { status, json } = await providerCheck(s, 'PAN');
    expect(status).toBe(409);
    expect(json.error?.code).toBe('KYC_CHECK_RUNNING');
    expect(calls.pan).not.toHaveBeenCalled();
  });

  it("a crashed run's stale claim is taken over", async () => {
    const s = await makeSeller();
    await prisma.sellerProfile.update({ where: { id: s.id }, data: { kycCheckStartedAt: new Date(Date.now() - 3 * 60 * 1000) } });
    expect((await providerCheck(s, 'PAN')).status).toBe(200);
  });
});

describe('an answer verifies nothing by itself', () => {
  it('a passed check waits for the admin, who can mark it verified only then', async () => {
    const s = await makeSeller();
    const early = await decide(s, 'PAN', 'VERIFY');
    expect(early.status).toBe(400);
    expect(early.json.error?.code).toBe('KYC_PROVIDER_CHECK_REQUIRED');
    expect(early.json.error?.message).toBe('Verify the PAN with Cashfree first.');

    const { json } = await providerCheck(s, 'PAN');
    expect(json.data.kyc.pan).toMatchObject({ state: 'PENDING_REVIEW', canMarkVerified: true });
    expect((await sellerView(s)).pan.state).toBe('PENDING_REVIEW');

    const marked = await decide(s, 'PAN', 'VERIFY');
    expect(marked.status).toBe(200);
    expect(marked.json.data.kyc.pan).toMatchObject({ state: 'VERIFIED', method: 'MANUAL', decidedBy: expect.stringContaining('KYC Admin') });
    expect(marked.json.data.kyc.pan.providerCheck?.outcome).toBe('VERIFIED');
  });

  it('a document the provider did not verify can only be rejected', async () => {
    const s = await makeSeller({ panNumber: 'ZZZZZ1234F' });
    await providerCheck(s, 'PAN');
    const refused = await decide(s, 'PAN', 'VERIFY');
    expect(refused.status).toBe(400);
    expect(refused.json.error?.message).toBe('Cashfree did not verify this PAN — it can only be rejected.');
    expect((await decide(s, 'PAN', 'REJECT', 'PAN does not exist')).json.data.kyc.pan.state).toBe('REJECTED');
  });

  it('no answer is not a pass', async () => {
    const s = await makeSeller({ bankAccountNo: '1234569999' });
    await providerCheck(s, 'BANK');
    const refused = await decide(s, 'BANK', 'VERIFY');
    expect(refused.json.error?.message).toBe('The bank account check did not complete — run it again.');
  });

  it('a name match below the threshold is not a pass, nor is a bank account checked without a name', async () => {
    const weak = await makeSeller({ panName: 'Rahul MOCK MODERATE' }); // scores 70
    await providerCheck(weak, 'PAN');
    expect((await decide(weak, 'PAN', 'VERIFY')).json.error?.message).toBe('The name match is 70, below the threshold of 85.');

    const nameless = await makeSeller({ bankAccountName: '' });
    await providerCheck(nameless, 'BANK');
    expect((await decide(nameless, 'BANK', 'VERIFY')).json.error?.code).toBe('KYC_PROVIDER_CHECK_REQUIRED');
  });

  it('the shop is VERIFIED only once the admin has marked all three, each after it passed', async () => {
    const s = await makeSeller();
    await prisma.sellerProfile.update({ where: { id: s.id }, data: { kycStatus: 'UNDER_REVIEW' } });
    for (const check of ['PAN', 'GSTIN', 'BANK'] as const) await providerCheck(s, check);
    // Three passes, no decisions: nothing is verified.
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.id } })).kycStatus).toBe('UNDER_REVIEW');
    const forced = await http('PATCH', `/api/admin/sellers/${s.id}/kyc`, s.admin, { kycStatus: 'VERIFIED' });
    expect(forced.status).toBe(400);

    await decide(s, 'PAN', 'VERIFY');
    await decide(s, 'GSTIN', 'VERIFY');
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.id } })).kycStatus).toBe('UNDER_REVIEW');
    await decide(s, 'BANK', 'VERIFY');
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.id } })).kycStatus).toBe('VERIFIED');
    // The verified bank account is the shop's verified payout account.
    expect(await prisma.sellerPayoutMethod.count({ where: { sellerId: s.id, verified: true, accountLast4: '7890' } })).toBe(1);
  });
});

describe('the bank account', () => {
  it('is checked again when the account changes, and only then', async () => {
    const s = await makeSeller();
    await providerCheck(s, 'BANK');
    let calls = spies();
    await providerCheck(s, 'BANK');
    expect(calls.bank).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    await prisma.sellerProfile.update({ where: { id: s.id }, data: { bankAccountNo: '9876543210' } });
    calls = spies();
    const after = await providerCheck(s, 'BANK');
    expect(after.json.data.called).toBe(true);
    expect(calls.bank).toHaveBeenCalledTimes(1);
  });

  it('asks for a name match only when there is a name to match', async () => {
    const s = await makeSeller({ bankAccountName: '' });
    const calls = spies();
    await providerCheck(s, 'BANK');
    expect(calls.bank).toHaveBeenCalledWith('1234567890', 'HDFC0001234', null);
    expect((await detail(s)).kycApprovalWarnings).toContain('Bank account is valid, but the account holder name was not checked.');
  });

  it('is checked again, with the name, once a name appears — the match is what proves ownership', async () => {
    const s = await makeSeller({ bankAccountName: '' });
    await providerCheck(s, 'BANK');
    await prisma.sellerProfile.update({ where: { id: s.id }, data: { bankAccountName: 'Rahul Sharma' } });
    const calls = spies();
    await providerCheck(s, 'BANK');
    expect(calls.bank).toHaveBeenCalledWith('1234567890', 'HDFC0001234', 'Rahul Sharma');
    expect((await detail(s)).kyc.bank.nameScore).toBe(100);
  });
});

describe('a GSTIN that is absent', () => {
  it('is never checked, raises no KYC warning — and blocks approval, since every tax invoice is issued under it', async () => {
    const s = await makeSeller({ gstNumber: '' });
    const calls = spies();
    const { json } = await providerCheck(s, 'GSTIN');
    expect(json.data.kyc.gstin.state).toBe('NOT_PROVIDED');
    expect(calls.gstin).not.toHaveBeenCalled();

    await providerCheck(s, 'PAN');
    await decide(s, 'PAN', 'VERIFY');
    await providerCheck(s, 'BANK');
    await decide(s, 'BANK', 'VERIFY');
    expect((await detail(s)).kycApprovalWarnings).toEqual([]);
    const approve = await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'approve' });
    expect(approve.status).toBe(400);
    expect((approve.json as unknown as { error: { code: string } }).error.code).toBe('GSTIN_REQUIRED');
  });
});

describe('fraud signals are surfaced, not buried', () => {
  it('a GSTIN carrying another PAN shows in the list and heads the detail', async () => {
    const s = await makeSeller({ panNumber: 'PQRST5678K', gstNumber: '29ABCDE1234F1Z5' });
    const d = await detail(s);
    expect(d.kyc.panGstinMismatch).toBe(true);
    expect(d.kycAlerts.panGstinMismatch).toBe(true);
    expect(d.kycApprovalWarnings[0]).toContain('PAN–GSTIN mismatch');
    expect(d.kycApprovalWarnings[0]).toContain('PQRST5678K');

    const list = await http<AdminSellerPage>('GET', '/api/admin/sellers?pageSize=100', s.admin);
    expect(list.json.data.rows.find((r) => r.id === s.id)?.kycAlerts.panGstinMismatch).toBe(true);
  });

  it("the provider's fraud flag on a bank account shows in the list and the detail", async () => {
    const s = await makeSeller({ bankAccountNo: '1234566666' });
    await providerCheck(s, 'BANK');
    const d = await detail(s);
    expect(d.kyc.fraudAccount).toBe(true);
    expect(d.kycAlerts.fraudAccount).toBe(true);
    expect(d.kycApprovalWarnings).toContain('Bank account is flagged as fraudulent by the verification provider.');
    expect((await decide(s, 'BANK', 'VERIFY')).status).toBe(400);

    const list = await http<AdminSellerPage>('GET', '/api/admin/sellers?pageSize=100', s.admin);
    expect(list.json.data.rows.find((r) => r.id === s.id)?.kycAlerts.fraudAccount).toBe(true);
  });
});

describe('approval', () => {
  it('is refused with the plain list of problems until the admin acknowledges it', async () => {
    const s = await makeSeller({ panName: '' });
    for (const check of ['GSTIN', 'BANK'] as const) {
      await providerCheck(s, check);
      await decide(s, check, 'VERIFY');
    }

    const refused = await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'approve' });
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code).toBe('KYC_WARNINGS_UNACKNOWLEDGED');
    expect(refused.json.error?.warnings).toEqual(['PAN has not been verified: the name to check against is missing.']);
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('PENDING');

    const approved = await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'approve', acknowledgeKycWarnings: true });
    expect(approved.status).toBe(200);
    // What was waved through is on record for the next admin.
    const note = await prisma.sellerNote.findFirstOrThrow({ where: { sellerId: s.id } });
    expect(note.body).toContain('Approved with KYC warnings acknowledged');
    expect(note.body).toContain('PAN has not been verified');
  });

  it('warns about a check that passed but is not yet marked verified', async () => {
    const s = await makeSeller();
    await providerCheck(s, 'PAN');
    expect((await detail(s)).kycApprovalWarnings).toContain('PAN passed the provider check and is waiting for an admin to mark it verified.');
  });

  it('cannot be had by reinstating a rejected application instead', async () => {
    const s = await makeSeller({ panName: '' });
    await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'reject', reason: 'Documents unclear' });
    const refused = await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'reinstate' });
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code).toBe('KYC_WARNINGS_UNACKNOWLEDGED');
    const approved = await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'reinstate', acknowledgeKycWarnings: true });
    expect(approved.status).toBe(200);
  });

  it('is not asked again when a once-approved seller is reinstated after a suspension', async () => {
    const s = await makeSeller({ panName: '' });
    await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'approve', acknowledgeKycWarnings: true });
    await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'suspend', reason: 'Late shipments' });
    const reinstated = await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'reinstate' });
    expect(reinstated.status).toBe(200);
  });

  it('needs no acknowledgement when all three were checked and marked verified', async () => {
    const s = await makeSeller();
    await verifyAll(s);
    const approve = await http('PATCH', `/api/admin/sellers/${s.id}/status`, s.admin, { action: 'approve' });
    expect(approve.status).toBe(200);
    expect(await prisma.sellerNote.count({ where: { sellerId: s.id } })).toBe(0);
  });
});

describe('the name-match threshold', () => {
  it('moves without re-verifying anyone', async () => {
    const s = await makeSeller({ panName: 'Rahul MOCK MODERATE' }); // scores 70
    await providerCheck(s, 'PAN');
    expect((await detail(s)).kyc.pan).toMatchObject({ nameMeetsThreshold: false, canMarkVerified: false }); // default 85

    const calls = spies();
    await http('PUT', '/api/admin/settings', s.admin, { kycNameMatchMinScore: 60 });
    try {
      const d = await detail(s);
      expect(d.kyc.pan).toMatchObject({ nameMeetsThreshold: true, canMarkVerified: true });
      expect(d.kyc.nameMatchThreshold).toBe(60);
      expect(calls.pan).not.toHaveBeenCalled();
    } finally {
      await http('PUT', '/api/admin/settings', s.admin, { kycNameMatchMinScore: 85 });
    }
  });
});

describe('the seller-facing endpoint', () => {
  it('shows states and reasons, never scores or bands', async () => {
    const s = await makeSeller({ panName: 'Rahul MOCK POOR' });
    await providerCheck(s, 'PAN');
    const text = JSON.stringify(await sellerView(s));
    expect(text).not.toContain('nameScore');
    expect(text).not.toContain('POOR_PARTIAL');
    expect(text).not.toContain('providerCheck');
    expect((await sellerView(s)).pan.nameNeedsReview).toBe(true);
  });

  it('is rate-limited per seller: five calls an hour', async () => {
    const s = await makeSeller();
    for (let i = 0; i < 5; i++) expect((await http('POST', '/api/seller/kyc/verify', s.token)).status).toBe(200);
    expect((await http('POST', '/api/seller/kyc/verify', s.token)).status).toBe(429);
  });
});

describe('providers', () => {
  it("do not inherit each other's answers — another provider's 'verified' is not this one's", async () => {
    const s = await makeSeller();
    await providerCheck(s, 'PAN');
    // As if these had come from a different provider than the one now live.
    await prisma.sellerKycCheck.updateMany({ where: { sellerId: s.id }, data: { provider: 'cashfree' } });

    expect((await detail(s)).kyc.pan.providerCheck).toBeNull();
    const calls = spies();
    await providerCheck(s, 'PAN');
    expect(calls.pan).toHaveBeenCalledTimes(1);
  });
});
