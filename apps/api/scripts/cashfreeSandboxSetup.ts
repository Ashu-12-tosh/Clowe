/**
 * Cashfree SANDBOX test helpers for a developer machine. Refuses to run
 * unless every Cashfree product is in sandbox and NODE_ENV is not production.
 *
 *   npx tsx scripts/cashfreeSandboxSetup.ts buyer      → a test buyer with an address and one item in the cart
 *   npx tsx scripts/cashfreeSandboxSetup.ts deliver <orderId> <daysAgo>
 *                                                      → mark the order delivered (as the courier would) and post the ledger
 *
 * Prints JSON for the test driver. The access token printed is a local
 * development token for the local database only.
 */
import { env } from '../src/env';
import { prisma } from '../src/db';
import { signAccessToken } from '../src/utils/jwt';
import { postDeliveryEntries } from '../src/services/sellerLedgerService';

if (env.NODE_ENV === 'production' || env.CASHFREE_PG_ENV !== 'sandbox' || env.CASHFREE_PAYOUT_ENV !== 'sandbox' || env.CASHFREE_VERIFICATION_ENV !== 'sandbox') {
  throw new Error('Sandbox only — refusing to run');
}

const PHONE = '9871000001';

async function buyer() {
  const user =
    (await prisma.user.findUnique({ where: { phone: PHONE } })) ??
    (await prisma.user.create({ data: { phone: PHONE, name: 'Cashfree Sandbox Buyer', email: 'sandbox.buyer@example.com', referralCode: 'CF-SANDBOX-1' } }));
  const address =
    (await prisma.address.findFirst({ where: { userId: user.id } })) ??
    (await prisma.address.create({ data: { userId: user.id, name: 'Sandbox Buyer', phone: PHONE, line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true } }));
  // The cheapest approved, in-stock variant from an approved shop.
  const variant = await prisma.productVariant.findFirstOrThrow({
    where: { stock: { gt: 5 }, product: { status: 'APPROVED', seller: { status: 'APPROVED', slug: { not: null } } } },
    orderBy: { pricePaise: 'asc' },
    select: { id: true, pricePaise: true, product: { select: { title: true, sellerId: true } } },
  });
  const cart = (await prisma.cart.findUnique({ where: { userId: user.id } })) ?? (await prisma.cart.create({ data: { userId: user.id } }));
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cartItem.create({ data: { cartId: cart.id, variantId: variant.id, quantity: 1 } });
  const token = signAccessToken({ sub: user.id, role: user.role });
  const authUser = {
    id: user.id,
    phone: user.phone,
    name: user.name,
    email: user.email,
    role: user.role,
    referralCode: user.referralCode,
    createdAt: user.createdAt.toISOString(),
    dateOfBirth: null,
    gender: null,
    avatarUrl: null,
  };
  console.log(JSON.stringify({ token, user: authUser, addressId: address.id, variant: { id: variant.id, pricePaise: variant.pricePaise, title: variant.product.title, sellerId: variant.product.sellerId } }));
}

async function deliver(orderId: string, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const items = await prisma.orderItem.findMany({ where: { orderId } });
  for (const i of items) {
    await prisma.orderItem.update({ where: { id: i.id }, data: { status: 'DELIVERED', shippedAt: at, deliveredAt: at } });
    await postDeliveryEntries(i.id);
  }
  await prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
  console.log(JSON.stringify({ delivered: items.map((i) => i.id), sellerIds: [...new Set(items.map((i) => i.sellerId))] }));
}

/** Make an order's gateway session look expired and run the sweeper once, as the 5-minute job would. */
async function sweep(orderId: string) {
  await prisma.payment.update({ where: { orderId }, data: { expiresAt: new Date(Date.now() - 10 * 60_000), lastCheckedAt: null } });
  const { sweepUnpaidGatewayPayments } = await import('../src/services/payments/gatewaySync');
  const r = await sweepUnpaidGatewayPayments();
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } });
  console.log(JSON.stringify({ sweep: r, order: order.status, payment: order.payment?.status, failureReason: order.payment?.failureReason }));
}

/** Run the refund and payout pollers once. */
async function poll() {
  const { pollProcessingRefunds } = await import('../src/services/refundService');
  const { pollProcessingPayouts } = await import('../src/services/payoutService');
  await prisma.refund.updateMany({ where: { status: 'PROCESSING' }, data: { lastCheckedAt: null } });
  await prisma.payout.updateMany({ where: { status: 'PROCESSING' }, data: { lastCheckedAt: null } });
  console.log(JSON.stringify({ refundsChecked: await pollProcessingRefunds(), payoutsChecked: await pollProcessingPayouts() }));
}

/** A short-lived local access token for an existing user (admin or seller) — local database only. */
async function token(phone: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  console.log(JSON.stringify({ token: signAccessToken({ sub: user.id, role: user.role }), userId: user.id, role: user.role }));
}

/** A browser snippet that signs the local web app in as this user (local database only). */
async function session(phone: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const user = { id: u.id, phone: u.phone, name: u.name, email: u.email, role: u.role, referralCode: u.referralCode, createdAt: u.createdAt.toISOString(), dateOfBirth: null, gender: null, avatarUrl: null };
  const t = signAccessToken({ sub: u.id, role: u.role });
  console.log(`() => { localStorage.setItem("clowe.accessToken", ${JSON.stringify(t)}); localStorage.setItem("clowe.user", ${JSON.stringify(JSON.stringify(user))}); return "ok"; }`);
}

const [cmd, a, b] = process.argv.slice(2);
(cmd === 'buyer'
  ? buyer()
  : cmd === 'deliver'
    ? deliver(a!, Number(b ?? 0))
    : cmd === 'sweep'
      ? sweep(a!)
      : cmd === 'poll'
        ? poll()
        : cmd === 'token'
          ? token(a!)
          : cmd === 'session'
            ? session(a!)
          : Promise.reject(new Error('usage: buyer | deliver <orderId> <daysAgo> | sweep <orderId> | poll | token <phone>')))
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
