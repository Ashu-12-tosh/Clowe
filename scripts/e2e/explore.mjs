// Dev aid: dump the accessible structure of pages the e2e drives, so its
// selectors follow the real UI. Usage: node scripts/e2e/explore.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, WEB, accessToken, playwright, prismaClient, startStack } from './stack.mjs';

const out = path.join(ROOT, 'e2e-results', 'explore');
fs.mkdirSync(out, { recursive: true });
const prisma = prismaClient();
const stack = await startStack({ log: console.log });
try {
  const stamp = String(Date.now()).slice(-7);
  const sellerUser = await prisma.user.create({ data: { phone: `97${stamp}1`, name: 'Explore Seller', role: 'SELLER', referralCode: `EXP-S${stamp}` } });
  await prisma.sellerProfile.create({
    data: { userId: sellerUser.id, shopName: `Explore Shop ${stamp}`, status: 'APPROVED', approvedAt: new Date(), gstNumber: '07AAWFC9519L1ZL', addressLine1: '1 Test Rd', city: 'New Delhi', state: 'Delhi', pincode: '110059' },
  });
  const shopperUser = await prisma.user.create({ data: { phone: `96${stamp}1`, name: 'Explore Shopper', role: 'CUSTOMER', referralCode: `EXP-C${stamp}` } });

  const { chromium } = playwright();
  const browser = await chromium.launch({ channel: 'chrome' });
  async function as(user) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('clowe.accessToken', t); localStorage.setItem('clowe.user', u); }, [accessToken(user.id, user.role), JSON.stringify({ id: user.id, phone: user.phone, name: user.name, role: user.role, email: null, hasPin: false })]);
    return ctx.newPage();
  }
  async function dump(page, name) {
    await page.waitForTimeout(2500);
    const snap = await page.locator('main, body').first().ariaSnapshot().catch((e) => `ERR ${e.message}`);
    fs.writeFileSync(path.join(out, `${name}.yml`), snap);
    console.log('dumped', name);
  }

  const seller = await as(sellerUser);
  await seller.goto(`${WEB}/seller/products/new`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await seller.getByText('1. Basic information').waitFor({ timeout: 240_000 });
  await dump(seller, 'product-1-basic');
  for (let i = 2; i <= 7; i++) {
    await seller.getByRole('button', { name: 'Next ›' }).click().catch(() => {});
    await dump(seller, `product-${i}`);
  }
  await seller.goto(`${WEB}/seller/settings`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(seller, 'seller-settings');
  await seller.goto(`${WEB}/seller`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(seller, 'seller-dashboard');
  await seller.goto(`${WEB}/seller/payouts`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(seller, 'seller-payouts');
  await seller.goto(`${WEB}/seller/tryon`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(seller, 'seller-tryon');
  await seller.goto(`${WEB}/seller/ads/new`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(seller, 'seller-ads-new');

  const shopper = await as(shopperUser);
  const product = await prisma.product.findFirst({ where: { status: 'APPROVED', isVisible: true }, select: { slug: true } });
  await shopper.goto(`${WEB}/products/${product.slug}`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(shopper, 'product-page');
  await shopper.goto(`${WEB}/cart`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(shopper, 'cart');
  await shopper.goto(`${WEB}/checkout`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(shopper, 'checkout');
  await shopper.goto(`${WEB}/account/help`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await dump(shopper, 'account-help');
  await browser.close();
} catch (err) {
  console.log('crashed', err.stack ?? err);
} finally {
  stack.stop();
  await prisma.$disconnect();
}
process.exit(0);
