// Quick look at the banner admin screens and the home page in a real browser,
// on the local mock stack. Usage: node scripts/e2e/smoke-banners.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, WEB, accessToken, playwright, prismaClient, startStack } from './stack.mjs';

const out = path.join(ROOT, 'e2e-results', 'smoke-banners');
fs.mkdirSync(out, { recursive: true });
const prisma = prismaClient();
const stack = await startStack({ log: console.log });
const problems = [];
try {
  const phone = `98${String(Date.now()).slice(-8)}`;
  const admin = await prisma.user.create({
    data: { phone, name: 'Smoke Admin', role: 'ADMIN', referralCode: `SMK-${phone.slice(-6)}` },
  });
  const token = accessToken(admin.id, 'ADMIN');
  const user = { id: admin.id, phone, name: admin.name, role: 'ADMIN', email: null, hasPin: false };

  const { chromium } = playwright();
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(
    ([t, u]) => {
      localStorage.setItem('clowe.accessToken', t);
      localStorage.setItem('clowe.user', u);
    },
    [token, JSON.stringify(user)],
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${page.url()}: ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`));

  await page.goto(`${WEB}/admin/banners`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await page.getByRole('button', { name: '+ New banner' }).click({ timeout: 240_000 });
  await page.fill('input[name=headline]', 'Smoke test banner');
  await page.locator('[data-banner-preview]').waitFor();
  await page.screenshot({ path: path.join(out, 'banner-designed.png'), fullPage: true });
  await page.getByText('Full image', { exact: true }).click();
  await page.getByRole('button', { name: /Save|Create/ }).last().click();
  await page.waitForTimeout(500);
  const fieldMsg = await page.locator('[role=alert]').allInnerTexts();
  if (!fieldMsg.some((t) => /needs its image/.test(t))) problems.push(`full image without image: no field error (${fieldMsg.join(' | ')})`);
  await page.getByRole('button', { name: '📱 Phone' }).click();
  await page.screenshot({ path: path.join(out, 'banner-full-error.png'), fullPage: true });

  await page.goto(`${WEB}/admin/category-banners`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await page.getByRole('button', { name: '+ New banner' }).click();
  await page.locator('[data-banner-preview]').waitFor();
  await page.screenshot({ path: path.join(out, 'category-banner.png'), fullPage: true });

  await page.goto(`${WEB}/admin/promos`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await page.locator('[data-banner-preview]').waitFor();
  await page.screenshot({ path: path.join(out, 'promos.png'), fullPage: true });

  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(out, 'home.png') });
  await browser.close();
  await prisma.user.delete({ where: { id: admin.id } });
} catch (err) {
  problems.push(`crashed: ${err.stack ?? err}`);
} finally {
  stack.stop();
  await prisma.$disconnect();
}
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'smoke OK');
console.log(`screenshots in ${out}`);
process.exit(0);
