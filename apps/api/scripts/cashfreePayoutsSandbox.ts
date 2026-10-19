/**
 * SANDBOX ONLY: Clowe's payout flow against Cashfree Payouts' sandbox, through
 * the real code — request (waits for approval) → admin approval → beneficiary
 * → transfer → the status sync the webhook and poller both use → PAID /
 * FAILED / REVERSED, with the seller's ledger checked at each end.
 *
 * Each case is a fresh test seller in the local database whose admin-verified
 * bank account is one of Cashfree's sandbox test accounts:
 *
 *   npx tsx scripts/cashfreePayoutsSandbox.ts
 *
 * Refuses to run unless PAYOUT_PROVIDER=cashfree on the sandbox, outside production.
 */
import { randomInt } from 'node:crypto';
import { env } from '../src/env';
import { prisma } from '../src/db';
import { encryptBankAccount } from '../src/services/bankAccountCrypto';
import { reviewSellerKyc } from '../src/services/kyc/sellerKyc';
import { postDeliveryEntries, settlementPosition } from '../src/services/sellerLedgerService';
import { approvePayout, requestPayout, syncPayout } from '../src/services/payoutService';
import { payoutProvider } from '../src/services/payouts';

if (env.NODE_ENV === 'production' || env.PAYOUT_PROVIDER !== 'cashfree' || env.CASHFREE_PAYOUT_ENV !== 'sandbox' || payoutProvider.name !== 'cashfree') {
  throw new Error('Sandbox only (PAYOUT_PROVIDER=cashfree, CASHFREE_PAYOUT_ENV=sandbox) — refusing to run');
}

/** Cashfree Payouts sandbox test accounts and what they do. */
const CASES = [
  { name: 'success', account: '00011020001772', ifsc: 'HDFC0000001', expect: ['PAID'] },
  { name: 'failure (invalid account)', account: '026291800001190', ifsc: 'YESB0000262', expect: ['FAILED'] },
  { name: 'success, later reversed', account: '7766671735000', ifsc: 'SBIN0000004', expect: ['REVERSED', 'PAID'] },
  { name: 'pending, later success', account: '00224412311300', ifsc: 'YESB0000001', expect: ['PAID', 'PROCESSING'] },
] as const;

const PRICE = 150_000; // ₹1,500: clears the ₹1,000 minimum payout after fees

async function testSeller(c: (typeof CASES)[number], adminId: string) {
  const tag = `${Date.now().toString(36)}${randomInt(100, 999)}`;
  const user = await prisma.user.create({ data: { phone: `95${String(randomInt(10_000_000, 99_999_999))}`, name: `Payout Sandbox ${c.name}`, role: 'SELLER', referralCode: `PSB-${tag}` } });
  const seller = await prisma.sellerProfile.create({
    data: {
      userId: user.id,
      shopName: `Payout Sandbox ${tag}`,
      status: 'APPROVED',
      approvedAt: new Date(),
      panNumber: 'ABCPV1234D',
      panName: 'John Doe',
      gstNumber: '29ABCPV1234D1Z5',
      bankAccountEnc: encryptBankAccount(c.account),
      bankAccountLast4: c.account.slice(-4),
      bankIfsc: c.ifsc,
      bankAccountName: 'John Doe',
      bankAccountType: 'CURRENT',
      bankName: 'Test Bank',
    },
  });
  // An admin's manual review — the KYC fallback; verifying the bank makes it the payout account.
  for (const check of ['PAN', 'GSTIN', 'BANK'] as const) await reviewSellerKyc({ sellerId: seller.id, check, decision: 'VERIFY', reviewerId: adminId });

  const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
  const product = await prisma.product.create({ data: { sellerId: seller.id, categoryId: category.id, title: `Payout sandbox ${tag}`, slug: `payout-sandbox-${tag}`, description: 'Payout sandbox test listing.', basePricePaise: PRICE, status: 'DRAFT' } });
  const variant = await prisma.productVariant.create({ data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: `PSB-${tag}`, pricePaise: PRICE, stock: 0 } });
  const order = await prisma.order.create({
    data: { orderNumber: `CLW-PSB-${tag.toUpperCase()}`, userId: user.id, shipName: 'S', shipPhone: '9100000000', shipLine1: '1 Road', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001', status: 'DELIVERED', subtotalPaise: PRICE, totalPaise: PRICE, paymentMethod: 'UPI' },
  });
  const deliveredAt = new Date(Date.now() - 10 * 86_400_000);
  const item = await prisma.orderItem.create({
    data: { orderId: order.id, productId: product.id, variantId: variant.id, sellerId: seller.id, title: 'payout sandbox line', size: '', color: '', pricePaise: PRICE, quantity: 1, status: 'DELIVERED', shippedAt: deliveredAt, deliveredAt, returnWindowDays: 5 },
  });
  await postDeliveryEntries(item.id);
  return seller.id;
}

const balanceOf = async (sellerId: string) => (await settlementPosition(sellerId, 0)).balancePaise;

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
  const results: Record<string, unknown>[] = [];
  for (const c of CASES) {
    const sellerId = await testSeller(c, admin.id);
    const before = await balanceOf(sellerId);
    const requested = await requestPayout(sellerId);
    const afterRequest = await balanceOf(sellerId);
    const sent = await approvePayout(requested.id, admin.id);
    let p = sent;
    const statuses: string[] = [String(requested.status), String(sent.status)];
    // The webhook and the poller both end in syncPayout; ask until it is final (or ~3 minutes).
    for (let i = 0; i < 18 && !(c.expect as readonly string[]).includes(String(p.status)) ; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      await syncPayout(p.id);
      p = await prisma.payout.findUniqueOrThrow({ where: { id: p.id } });
      if (statuses.at(-1) !== p.status) statuses.push(String(p.status));
    }
    // A reversal comes after the success: keep asking a little longer for that case.
    if (c.name.includes('reversed') && p.status === 'PAID') {
      for (let i = 0; i < 18 && p.status === 'PAID'; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        await syncPayout(p.id);
        p = await prisma.payout.findUniqueOrThrow({ where: { id: p.id } });
      }
      if (statuses.at(-1) !== p.status) statuses.push(String(p.status));
    }
    const method = await prisma.sellerPayoutMethod.findFirst({ where: { sellerId, type: 'BANK' } });
    const final = await balanceOf(sellerId);
    results.push({
      case: c.name,
      reference: p.reference,
      transferId: p.transferId,
      statuses: statuses.join(' → '),
      net: p.netPaise / 100,
      utr: p.utr,
      cashfree: p.providerStatus,
      failure: p.failureReason,
      beneficiary: method?.beneficiaryId,
      ledger: { before: before / 100, afterRequest: afterRequest / 100, final: final / 100 },
    });
    console.log(JSON.stringify(results.at(-1)));
  }
}

main()
  .catch((err) => console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })))
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
