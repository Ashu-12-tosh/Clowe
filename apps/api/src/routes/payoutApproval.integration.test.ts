import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminPayoutAccount, AdminPayoutRow } from '@clowe/shared';
import { createApp } from '../app';
import { env } from '../env';
import { seedFixture } from '../test/fixture';
import { verifiedPan } from '../test/kyc';
import { signAccessToken } from '../utils/jwt';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { postDeliveryEntries, settlementPosition } from '../services/sellerLedgerService';
import { eligibleItems, pollProcessingPayouts } from '../services/payoutService';
import { setPayoutProviderForTests } from '../services/payouts';
import { GatewayError } from '../services/payments/PaymentProvider';
import type { PayoutBalance, PayoutBeneficiary, PayoutProvider, PayoutTransfer, PayoutTransferRequest } from '../services/payouts/PayoutProvider';

/**
 * Payouts move real money, so at first every one waits for an admin: approve
 * and it is sent, reject and the amount is back in the seller's balance, and
 * either way the audit log has it. With Cashfree Payouts a transfer finishes
 * later — by webhook or poll — and can even come back from the bank; each of
 * those leaves the seller's balance exactly right.
 */

class FakePayouts implements PayoutProvider {
  readonly name = 'cashfree';
  beneficiaries: PayoutBeneficiary[] = [];
  transfers: PayoutTransferRequest[] = [];
  /** Answers to transfer() in order (default PROCESSING); getTransfer reads `state`. */
  nextTransfer: Array<PayoutTransfer['status'] | 'THROW_UNCERTAIN'> = [];
  state = new Map<string, PayoutTransfer>();
  /** What the Payouts account holds; 'THROW' when the balance cannot be read. */
  availablePaise: number | 'THROW' = 100_000_000;
  /** Sent since availablePaise was last set: Cashfree's "available" nets off transfers on their way. */
  sentPaise = 0;
  async getBalance(): Promise<PayoutBalance> {
    if (this.availablePaise === 'THROW') throw new GatewayError('Cashfree Payouts v1/getBalance: timed out', 0, 'network');
    // Answered a moment later, as a real call would be.
    await new Promise((r) => setTimeout(r, 20));
    return { balancePaise: this.availablePaise, availablePaise: this.availablePaise - this.sentPaise };
  }
  async ensureBeneficiary(b: PayoutBeneficiary): Promise<string> {
    this.beneficiaries.push(b);
    return b.id;
  }
  async transfer(r: PayoutTransferRequest): Promise<PayoutTransfer> {
    this.transfers.push(r);
    this.sentPaise += r.amountPaise;
    const next = this.nextTransfer.shift() ?? 'PROCESSING';
    if (next === 'THROW_UNCERTAIN') throw new GatewayError('timed out', 0, 'network');
    const t: PayoutTransfer = { status: next, providerTransferId: `cf_${r.transferId}`, providerStatus: next, utr: next === 'PAID' ? `UTR${r.transferId}` : null, failureReason: next === 'FAILED' ? 'Insufficient balance' : undefined };
    this.state.set(r.transferId, t);
    return t;
  }
  async getTransfer(id: string): Promise<PayoutTransfer | null> {
    return this.state.get(id) ?? null;
  }
  async verifyMethod() {
    return { verified: false };
  }
  settle(id: string, status: PayoutTransfer['status']) {
    this.state.set(id, { ...this.state.get(id)!, status, utr: status === 'PAID' ? `UTR_${id}` : null, failureReason: status === 'REVERSED' ? 'Account closed' : undefined });
  }
}

const prisma = new PrismaClient();
const PAYOUT_SECRET = 'cf-payout-test-secret';
let server: Server;
let base: string;
let adminToken: string;
let adminId: string;
let categoryId: string;
let seq = 0;
const PRICE = 300_000;

async function call<T = unknown>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data: T; error?: { code: string; message: string } } };
}

/** An approved, KYC-verified seller with one delivered line and a payout method (UPI, or the verified bank account). */
async function payableSeller(opts: { method?: 'UPI' | 'BANK'; deliveredDaysAgo?: number; returnWindowDays?: number | null } = {}) {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `93100${String(seq).padStart(5, '0')}`, name: `Payout Seller ${seq}`, role: Role.SELLER, referralCode: `PO-S-${seq}` } });
  const seller = await prisma.sellerProfile.create({ data: { userId: user.id, shopName: `Payout Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date() } });
  await verifiedPan(seller.id, 'ABCDE1234F', `Payout Seller ${seq}`);
  const product = await prisma.product.create({
    data: { sellerId: seller.id, categoryId, title: `Payout ${seq}`, slug: `payout-approval-${seq}`, description: 'Payout test listing.', basePricePaise: PRICE, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: `PO-SKU-${seq}`, pricePaise: PRICE, stock: 5 },
  });
  const shopper = await prisma.user.create({ data: { phone: `93200${String(seq).padStart(5, '0')}`, name: 'Payout Shopper', referralCode: `PO-U-${seq}` } });
  const order = await prisma.order.create({
    data: { orderNumber: `CLW-PO-${seq}`, userId: shopper.id, shipName: 'S', shipPhone: '9170000000', shipLine1: '1 Lane', shipCity: 'City', shipState: 'Maharashtra', shipPincode: '400001', status: 'DELIVERED', subtotalPaise: PRICE, totalPaise: PRICE, paymentMethod: 'UPI' },
  });
  const deliveredAt = new Date(Date.now() - (opts.deliveredDaysAgo ?? 0) * 86_400_000 - 60_000);
  const item = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId: product.id,
      variantId: variant.id,
      sellerId: seller.id,
      title: 'payout line',
      size: '',
      color: '',
      pricePaise: PRICE,
      quantity: 1,
      status: 'DELIVERED',
      shippedAt: deliveredAt,
      deliveredAt,
      returnWindowDays: opts.returnWindowDays === undefined ? 0 : opts.returnWindowDays,
    },
  });
  await postDeliveryEntries(item.id);
  const method =
    opts.method === 'BANK'
      ? await prisma.sellerPayoutMethod.findFirstOrThrow({ where: { sellerId: seller.id, type: 'BANK' } })
      : await prisma.sellerPayoutMethod.create({
          data: { sellerId: seller.id, type: 'UPI', label: 'UPI', accountName: `Payout Seller ${seq}`, upiId: `po${seq}@upi`, isDefault: true, verified: true },
        });
  return { sellerId: seller.id, userId: user.id, itemId: item.id, methodId: method.id, token: signAccessToken({ sub: user.id, role: 'SELLER' }) };
}

const request = (token: string, methodId?: string) => call<{ id: string; status: string; reference: string; netPaise: number }>('POST', '/api/seller/payouts/request', token, methodId ? { methodId } : {});
const balanceOf = async (sellerId: string) => (await settlementPosition(sellerId, 0)).balancePaise;

beforeAll(async () => {
  await seedFixture(prisma);
  categoryId = (await prisma.category.findFirstOrThrow({ where: { isActive: true } })).id;
  const admin = await prisma.user.create({ data: { phone: '9310099999', name: 'Payout Admin', role: Role.ADMIN, referralCode: 'PO-A' } });
  adminToken = signAccessToken({ sub: admin.id, role: 'ADMIN' });
  adminId = admin.id;
  await setSetting('payoutHoldDays', 0);
  await setSetting('payoutMinPaise', 0);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await setSetting('payoutAutoApprove', false);
});

afterAll(async () => {
  for (const key of ['payoutHoldDays', 'payoutMinPaise', 'payoutAutoApprove', 'returnWindowDays'] as const) await setSetting(key, DEFAULT_SETTINGS[key]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('payout approval', () => {
  it('a requested payout waits for an admin, with its amount set aside from the balance', async () => {
    const s = await payableSeller();
    const before = await balanceOf(s.sellerId);
    const res = await request(s.token);
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe('PENDING');
    expect(await balanceOf(s.sellerId)).toBe(before - res.json.data.netPaise);
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: res.json.data.id } })).toMatchObject({ transferId: res.json.data.reference.replace('-', '_') });
    // One at a time.
    expect((await request(s.token)).json.error?.code).toBe('PAYOUT_IN_PROGRESS');
    const list = await call<{ rows: AdminPayoutRow[] }>('GET', '/api/admin/payouts?status=PENDING', adminToken);
    expect(list.json.data.rows.map((r) => r.id)).toContain(res.json.data.id);
  });

  it('rejected: nothing is sent, the amount is back in the balance, its lines payable again, and it is in the audit log', async () => {
    const s = await payableSeller();
    const before = await balanceOf(s.sellerId);
    const payout = (await request(s.token)).json.data;
    expect((await call('POST', `/api/admin/payouts/${payout.id}/reject`, adminToken, { reason: 'x' })).status).toBe(400);
    const res = await call<AdminPayoutRow>('POST', `/api/admin/payouts/${payout.id}/reject`, adminToken, { reason: 'Bank name does not match the shop' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'REJECTED', rejectionReason: 'Bank name does not match the shop', reviewedBy: 'Payout Admin' });
    expect(await balanceOf(s.sellerId)).toBe(before);
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: s.itemId } })).toMatchObject({ payoutId: null });
    expect(await prisma.notification.count({ where: { userId: s.userId, title: 'Payout not approved' } })).toBe(1);
    // Written before the response, not in the background.
    expect(await prisma.auditLog.count({ where: { action: 'Payout rejected', entityId: payout.id } })).toBe(1);
    // And it can be requested again.
    expect((await request(s.token)).json.data.status).toBe('PENDING');
  });

  it('approved: sent at once (mock payouts: paid), recorded with who approved it', async () => {
    const s = await payableSeller();
    const payout = (await request(s.token)).json.data;
    const res = await call<AdminPayoutRow>('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'PAID', reviewedBy: 'Payout Admin', utr: expect.stringMatching(/^UTR/) });
    expect(await prisma.auditLog.count({ where: { action: 'Payout approved', entityId: payout.id } })).toBe(1);
    // Not twice.
    expect((await call('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken)).json.error?.code).toBe('PAYOUT_NOT_PENDING');
  });

  it('is not approved for a seller suspended since the request', async () => {
    const s = await payableSeller();
    const payout = (await request(s.token)).json.data;
    await prisma.sellerProfile.update({ where: { id: s.sellerId }, data: { status: SellerStatus.SUSPENDED } });
    expect((await call('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken)).json.error?.code).toBe('SELLER_NOT_PAYABLE');
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('PENDING');
  });

  it('is skipped when auto-approve is on', async () => {
    await setSetting('payoutAutoApprove', true);
    const s = await payableSeller();
    expect((await request(s.token)).json.data.status).toBe('PAID');
  });

  it('is for admins only', async () => {
    const s = await payableSeller();
    expect((await call('GET', '/api/admin/payouts', s.token)).status).toBe(403);
  });
});

describe('Cashfree payouts', () => {
  const fake = new FakePayouts();
  let restore: () => void;
  beforeAll(() => {
    restore = setPayoutProviderForTests(fake);
    (env as { CASHFREE_PAYOUT_CLIENT_SECRET?: string }).CASHFREE_PAYOUT_CLIENT_SECRET = PAYOUT_SECRET;
  });
  afterAll(() => {
    restore();
    (env as { CASHFREE_PAYOUT_CLIENT_SECRET?: string }).CASHFREE_PAYOUT_CLIENT_SECRET = undefined;
  });
  beforeEach(() => {
    fake.nextTransfer = [];
    fake.availablePaise = 100_000_000;
    fake.sentPaise = 0;
  });

  const webhook = (transferId: string, type = 'TRANSFER_SUCCESS', signedAt = Date.now()) => {
    const raw = JSON.stringify({ type, event_time: new Date(signedAt).toISOString(), data: { transfer: { transfer_id: transferId } } });
    const ts = String(signedAt);
    const sig = createHmac('sha256', PAYOUT_SECRET).update(ts).update(raw).digest('base64');
    return call('POST', '/api/payouts/cashfree/webhook', null, raw, { 'x-webhook-timestamp': ts, 'x-webhook-signature': sig });
  };

  async function approved(opts: Parameters<typeof payableSeller>[0] = {}) {
    const s = await payableSeller(opts);
    const payout = (await request(s.token, s.methodId)).json.data;
    const res = await call<AdminPayoutRow>('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken);
    const row = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    return { ...s, payout: row, approvedRow: res.json.data };
  }

  it('never sends one by itself: with Cashfree sending, auto-approve is ignored and every payout waits for an admin', async () => {
    await setSetting('payoutAutoApprove', true);
    const s = await payableSeller();
    const sent = fake.transfers.length;
    const res = await request(s.token);
    expect(res.json.data.status).toBe('PENDING');
    expect(fake.transfers.length).toBe(sent);
  });

  it('an approval the Payouts balance cannot cover sends nothing: the payout stays PENDING and the admins are told', async () => {
    const s = await payableSeller();
    const payout = (await request(s.token)).json.data;
    fake.availablePaise = payout.netPaise - 1;
    const sent = fake.transfers.length;
    const res = await call('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken);
    expect(res.status).toBe(409);
    expect(res.json.error?.code).toBe('PAYOUT_BALANCE_LOW');
    expect(fake.transfers.length).toBe(sent);
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: 'PENDING', reviewedAt: null });
    await vi.waitFor(async () => expect(await prisma.notification.count({ where: { userId: adminId, type: 'ADMIN_PAYOUT_BALANCE_LOW', body: { contains: payout.reference } } })).toBe(1));

    // Topped up: the same approval goes through.
    fake.availablePaise = payout.netPaise;
    expect((await call<AdminPayoutRow>('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken)).json.data.status).toBe('PROCESSING');
    expect(fake.transfers.length).toBe(sent + 1);
  });

  it('two payouts approved at the same moment cannot both be paid from money that covers one', async () => {
    const [a, b] = [await payableSeller(), await payableSeller()];
    const pa = (await request(a.token)).json.data;
    const pb = (await request(b.token)).json.data;
    fake.availablePaise = Math.max(pa.netPaise, pb.netPaise);
    const sent = fake.transfers.length;
    const results = await Promise.all([
      call('POST', `/api/admin/payouts/${pa.id}/approve`, adminToken),
      call('POST', `/api/admin/payouts/${pb.id}/approve`, adminToken),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(fake.transfers.length).toBe(sent + 1);
  });

  it('an approval sends nothing when the balance cannot be read', async () => {
    const s = await payableSeller();
    const payout = (await request(s.token)).json.data;
    fake.availablePaise = 'THROW';
    const sent = fake.transfers.length;
    const res = await call('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken);
    expect(res.status).toBe(502);
    expect(res.json.error?.code).toBe('PAYOUT_BALANCE_UNKNOWN');
    expect(fake.transfers.length).toBe(sent);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('PENDING');
  });

  it('saves the verified bank account as a beneficiary once, and sends under the fixed transfer id', async () => {
    const { payout, methodId } = await approved({ method: 'BANK' });
    expect(payout.status).toBe('PROCESSING');
    const b = fake.beneficiaries.at(-1)!;
    expect(b).toMatchObject({ id: `CLWB_${methodId}`, accountNumber: '1234567890', ifsc: 'HDFC0001234' });
    expect(fake.transfers.at(-1)).toMatchObject({ transferId: payout.transferId, beneficiaryId: `CLWB_${methodId}`, mode: 'banktransfer', amountPaise: payout.netPaise });
    expect((await prisma.sellerPayoutMethod.findUniqueOrThrow({ where: { id: methodId } })).beneficiaryId).toBe(`CLWB_${methodId}`);
  });

  it('is PAID when the signed webhook arrives and Cashfree confirms it; an unsigned one is refused', async () => {
    const { payout, userId } = await approved();
    fake.settle(payout.transferId!, 'PAID');
    expect((await call('POST', '/api/payouts/cashfree/webhook', null, '{"type":"TRANSFER_SUCCESS"}', {})).status).toBe(401);
    // Signed, but over an hour ago: a captured delivery sent again is refused.
    expect((await webhook(payout.transferId!, 'TRANSFER_SUCCESS', Date.now() - 61 * 60 * 1000)).status).toBe(401);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('PROCESSING');
    expect((await webhook(payout.transferId!)).status).toBe(200);
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: 'PAID', utr: `UTR_${payout.transferId}` });
    expect(await prisma.notification.count({ where: { userId, type: 'PAYOUT_SENT' } })).toBe(1);
  });

  it('a transfer the bank sends back is REVERSED: its lines payable again and the balance restored', async () => {
    const { payout, sellerId, itemId } = await approved();
    const reserved = await balanceOf(sellerId);
    fake.settle(payout.transferId!, 'PAID');
    await webhook(payout.transferId!);
    fake.settle(payout.transferId!, 'REVERSED');
    await webhook(payout.transferId!, 'TRANSFER_REVERSED');
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: 'REVERSED', failureReason: 'Account closed' });
    expect(await balanceOf(sellerId)).toBe(reserved + payout.netPaise);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).payoutId).toBeNull();
    expect((await eligibleItems(sellerId, 0)).map((i) => i.id)).toContain(itemId);
    // In the audit log by the time the webhook is answered — at the highest severity.
    expect(await prisma.auditLog.findFirst({ where: { action: 'Payout reversed', entityId: payout.id } })).toMatchObject({ severity: 'CRITICAL', actorRole: 'SYSTEM' });
  });

  it('a reversal the poller finds (no webhook) is in the audit log the moment the poll returns', async () => {
    const { payout, sellerId } = await approved();
    fake.settle(payout.transferId!, 'PAID');
    await pollProcessingPayouts();
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('PAID');
    fake.settle(payout.transferId!, 'REVERSED');
    // A PAID payout is asked about again only on a webhook or an admin's check; the check is the poller-less path.
    const res = await call<AdminPayoutRow>('POST', `/api/admin/payouts/${payout.id}/check`, adminToken);
    expect(res.json.data.status).toBe('REVERSED');
    expect(await prisma.auditLog.count({ where: { action: 'Payout reversed', entityId: payout.id } })).toBe(1);
    expect(await prisma.sellerLedgerEntry.count({ where: { sellerId, idempotencyKey: `payout-release:${payout.id}` } })).toBe(1);
  });

  it('a transfer still in flight that comes back reversed, found by the poller, is audited at once', async () => {
    const { payout } = await approved();
    fake.settle(payout.transferId!, 'REVERSED');
    await prisma.payout.update({ where: { id: payout.id }, data: { lastCheckedAt: null } });
    await pollProcessingPayouts();
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('REVERSED');
    expect(await prisma.auditLog.count({ where: { action: 'Payout reversed', entityId: payout.id } })).toBe(1);
  });

  it('a failed or reversed payout is put in front of the admins, not only in the audit log', async () => {
    fake.nextTransfer = ['FAILED'];
    const failed = await approved();
    await vi.waitFor(async () => expect(await prisma.notification.count({ where: { userId: adminId, type: 'ADMIN_PAYOUT_FAILED', title: { contains: failed.payout.reference } } })).toBe(1));
    const reversed = await approved();
    fake.settle(reversed.payout.transferId!, 'REVERSED');
    await webhook(reversed.payout.transferId!, 'TRANSFER_REVERSED');
    await vi.waitFor(async () => expect(await prisma.notification.count({ where: { userId: adminId, type: 'ADMIN_PAYOUT_REVERSED', title: { contains: reversed.payout.reference } } })).toBe(1));
  });

  it('a transfer Cashfree refuses is FAILED and gives the money back', async () => {
    fake.nextTransfer = ['FAILED'];
    const { payout, sellerId } = await approved();
    expect(payout).toMatchObject({ status: 'FAILED', failureReason: 'Insufficient balance' });
    expect(await prisma.sellerLedgerEntry.count({ where: { sellerId, idempotencyKey: `payout-release:${payout.id}` } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'Payout failed', entityId: payout.id } })).toBe(1);
  });

  it('no answer at all leaves it PROCESSING; the poller resends the same transfer only if Cashfree never got it', async () => {
    fake.nextTransfer = ['THROW_UNCERTAIN', 'PAID'];
    const { payout } = await approved();
    expect(payout).toMatchObject({ status: 'PROCESSING', providerStatus: 'UNCONFIRMED' });
    await pollProcessingPayouts();
    const after = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    expect(after.status).toBe('PAID');
    const sent = fake.transfers.filter((t) => t.transferId === payout.transferId);
    expect(sent).toHaveLength(2);
  });
});

describe('the payout webhook before Cashfree sends (PAYOUT_PROVIDER still the mock)', () => {
  beforeAll(() => {
    (env as { CASHFREE_PAYOUT_CLIENT_SECRET?: string }).CASHFREE_PAYOUT_CLIENT_SECRET = PAYOUT_SECRET;
  });
  afterAll(() => {
    (env as { CASHFREE_PAYOUT_CLIENT_SECRET?: string }).CASHFREE_PAYOUT_CLIENT_SECRET = undefined;
  });
  const post = (body: unknown, secret = PAYOUT_SECRET) => {
    const raw = JSON.stringify(body);
    const ts = String(Date.now());
    const sig = createHmac('sha256', secret).update(ts).update(raw).digest('base64');
    return call<{ received: boolean }>('POST', '/api/payouts/cashfree/webhook', null, raw, { 'x-webhook-timestamp': ts, 'x-webhook-signature': sig });
  };

  it('still checks the signature, so the dashboard test proves the secret: a good one is recorded, a bad one refused', async () => {
    const test = { type: 'TRANSFER_SUCCESS', event_time: new Date().toISOString(), data: { transfer_id: `dashboard_test_${Date.now()}`, status: 'SUCCESS' } };
    expect((await post(test, 'some-other-secret')).status).toBe(401);
    expect(await prisma.gatewayWebhookEvent.count({ where: { provider: 'cashfree-payouts', reference: test.data.transfer_id } })).toBe(0);
    const ok = await post(test);
    expect(ok.status).toBe(200);
    expect(await prisma.gatewayWebhookEvent.count({ where: { provider: 'cashfree-payouts', reference: test.data.transfer_id, type: 'TRANSFER_SUCCESS' } })).toBe(1);
  });

  it('logs what a refused delivery carried — header names, content type, body size — never a value or the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Past the once-a-minute throttle left by earlier refusals in this file.
    const now = Date.now() + 10 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const res = await call('POST', '/api/payouts/cashfree/webhook', null, JSON.stringify({ type: 'LOW_BALANCE_ALERT', data: { note: 'BODY-SECRET-TEXT' } }), {
        'x-mystery-signature': 'HEADER-SECRET-VALUE',
      });
      expect(res.status).toBe(401);
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('payout webhook')) ?? '';
      expect(line).toContain('signature check FAILED (no signature header)');
      expect(line).toContain('x-mystery-signature');
      expect(line).toContain('content-type: application/json');
      expect(line).toMatch(/raw body: \d+ bytes/);
      expect(line).not.toContain('HEADER-SECRET-VALUE');
      expect(line).not.toContain('BODY-SECRET-TEXT');
    } finally {
      clock.mockRestore();
      warn.mockRestore();
    }
  });

  it('acts on nothing: a payout of ours on its way, named in it, is left as it is', async () => {
    // A provider that would answer "reversed" if it were asked — under the mock's name.
    const asked: string[] = [];
    const standIn = Object.assign(new FakePayouts(), { name: 'mock' as const });
    standIn.getTransfer = async (id: string) => {
      asked.push(id);
      return { status: 'REVERSED', providerStatus: 'REVERSED', failureReason: 'Account closed' };
    };
    const restore = setPayoutProviderForTests(standIn);
    try {
      const s = await payableSeller();
      const payout = (await request(s.token)).json.data;
      const row = await prisma.payout.update({ where: { id: payout.id }, data: { status: 'PROCESSING' } });
      expect((await post({ type: 'TRANSFER_REVERSED', data: { transfer_id: row.transferId } })).status).toBe(200);
      expect(asked).toEqual([]);
      expect((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe('PROCESSING');
    } finally {
      restore();
    }
  });
});

describe('the Payouts account on the admin page', () => {
  it('says who sends, and reads no balance without Payouts keys', async () => {
    const res = await call<AdminPayoutAccount>('GET', '/api/admin/payouts/account', adminToken);
    expect(res.json.data).toMatchObject({ sending: 'mock', configured: false, balancePaise: null });
    const s = await payableSeller();
    expect((await call('GET', '/api/admin/payouts/account', s.token)).status).toBe(403);
  });
});

describe('the hold', () => {
  it('covers the line’s own return window when it is longer than the payout hold', async () => {
    await setSetting('payoutHoldDays', 7);
    try {
      const inside = await payableSeller({ deliveredDaysAgo: 8, returnWindowDays: 10 });
      expect(await eligibleItems(inside.sellerId, { holdDays: 7, defaultWindowDays: 5 })).toHaveLength(0);
      expect((await settlementPosition(inside.sellerId, { holdDays: 7, defaultWindowDays: 5 })).availablePaise).toBe(0);
      expect((await request(inside.token)).json.error?.code).toBe('NOTHING_PAYABLE');

      const past = await payableSeller({ deliveredDaysAgo: 11, returnWindowDays: 10 });
      expect(await eligibleItems(past.sellerId, { holdDays: 7, defaultWindowDays: 5 })).toHaveLength(1);
      expect((await settlementPosition(past.sellerId, { holdDays: 7, defaultWindowDays: 5 })).availablePaise).toBeGreaterThan(0);

      // A line with no window of its own follows the platform's.
      const unset = await payableSeller({ deliveredDaysAgo: 8, returnWindowDays: null });
      expect(await eligibleItems(unset.sellerId, { holdDays: 7, defaultWindowDays: 10 })).toHaveLength(0);
      expect(await eligibleItems(unset.sellerId, { holdDays: 7, defaultWindowDays: 5 })).toHaveLength(1);
    } finally {
      await setSetting('payoutHoldDays', 0);
    }
  });
});

// Pre-launch audit (2026-10-21): money moving twice when requests arrive
// together — a double-clicked request or approval, or the webhook, the poller
// and a manual sync all finding the same reversal at once.
describe('races', () => {
  const fake = new FakePayouts();
  let restore: () => void;
  beforeAll(() => {
    restore = setPayoutProviderForTests(fake);
  });
  afterAll(() => restore());

  it('five payout requests at once: one payout, the balance set aside once', async () => {
    const s = await payableSeller();
    const before = await balanceOf(s.sellerId);
    const answers = await Promise.all(Array.from({ length: 5 }, () => request(s.token, s.methodId)));
    const made = answers.filter((a) => a.status === 200);
    expect(made).toHaveLength(1);
    expect(await prisma.payout.count({ where: { sellerId: s.sellerId } })).toBe(1);
    expect(await balanceOf(s.sellerId)).toBe(before - made[0]!.json.data.netPaise);
  });

  it('an approval double-clicked (or two admins at once): one transfer', async () => {
    const s = await payableSeller();
    const payout = (await request(s.token, s.methodId)).json.data;
    const sent = fake.transfers.length;
    const answers = await Promise.all(Array.from({ length: 4 }, () => call('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken)));
    expect(fake.transfers.length - sent).toBe(1);
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(answers.filter((a) => a.json.error?.code === 'PAYOUT_NOT_PENDING')).toHaveLength(3);
    expect(await prisma.auditLog.count({ where: { action: 'Payout approved', entityId: payout.id } })).toBe(1);
  });

  it('the same reversal found three ways at once: the money comes back once', async () => {
    const s = await payableSeller();
    const payout = (await request(s.token, s.methodId)).json.data;
    await call('POST', `/api/admin/payouts/${payout.id}/approve`, adminToken);
    const row = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    const reserved = await balanceOf(s.sellerId);
    fake.settle(row.transferId!, 'REVERSED');
    const { syncPayout } = await import('../services/payoutService');
    await Promise.all([syncPayout(row.id), syncPayout(row.id), pollProcessingPayouts(new Date(Date.now() + 3_600_000))]);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('REVERSED');
    expect(await balanceOf(s.sellerId)).toBe(reserved + row.netPaise);
    expect(await prisma.auditLog.count({ where: { action: 'Payout reversed', entityId: row.id } })).toBe(1);
  });
});
