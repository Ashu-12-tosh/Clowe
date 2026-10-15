// Upload through the admin banner form (stored resized), then the home page
// at phone width (hero picture shown), on the local mock stack.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, WEB, accessToken, apiRequire, playwright, prismaClient, startStack } from './stack.mjs';

const out = path.join(ROOT, 'e2e-results', 'smoke-fixes');
fs.mkdirSync(out, { recursive: true });
const prisma = prismaClient();
const stack = await startStack({ log: console.log });
const problems = [];
const notes = [];
try {
  const phone = `98${String(Date.now()).slice(-8)}`;
  const admin = await prisma.user.create({ data: { phone, name: 'Smoke Admin', role: 'ADMIN', referralCode: `SMK-${phone.slice(-6)}` } });
  const token = accessToken(admin.id, 'ADMIN');
  const user = { id: admin.id, phone, name: admin.name, role: 'ADMIN', email: null, hasPin: false };
  const sharp = apiRequire('sharp');
  const img = path.join(out, 'hero-2400x900.jpg');
  await sharp({ create: { width: 2400, height: 900, channels: 3, background: '#7a5c1e' } }).jpeg().toFile(img);

  const { chromium } = playwright();
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(([t, u]) => { localStorage.setItem('clowe.accessToken', t); localStorage.setItem('clowe.user', u); }, [token, JSON.stringify(user)]);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${page.url()}: ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`));

  await page.goto(`${WEB}/admin/banners`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await page.getByRole('button', { name: '+ New banner' }).click({ timeout: 240_000 });
  await page.fill('input[name=headline]', 'Smoke upload banner');
  await page.locator('input[type=file]').first().setInputFiles(img);
  await page.waitForFunction(() => document.querySelector('input[name=imageUrl]')?.value.includes('/uploads/'), null, { timeout: 60_000 }).catch(() => {});
  const url = await page.locator('input[name=imageUrl]').inputValue();
  notes.push(`uploaded → ${url}`);
  if (!/-w2000\.webp$/.test(url)) problems.push(`upload URL is not the 2000 copy: ${url}`);
  const toastText = await page.locator('[data-toast]').allInnerTexts();
  notes.push(`toasts: ${toastText.join(' | ')}`);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'admin-after-create.png') });

  const phonePage = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  phonePage.on('pageerror', (e) => problems.push(`pageerror phone: ${e.message}`));
  // The home payload is cached 60 s; the new banner may not be first. Look for any hero picture.
  await phonePage.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  await phonePage.waitForTimeout(8000);
  await phonePage.screenshot({ path: path.join(out, 'home-phone.png') });
  const heroImgs = await phonePage.locator('section[aria-roledescription=carousel] img').evaluateAll((els) =>
    els.map((e) => ({ src: e.currentSrc || e.src, visible: e.getBoundingClientRect().width > 0 })),
  );
  notes.push(`hero images on phone: ${JSON.stringify(heroImgs.slice(0, 3))}`);
  await browser.close();
  await prisma.homeBanner.deleteMany({ where: { headline: 'Smoke upload banner' } });
  await prisma.user.delete({ where: { id: admin.id } });
} catch (err) {
  problems.push(`crashed: ${err.stack ?? err}`);
} finally {
  stack.stop();
  await prisma.$disconnect();
}
console.log(notes.join('\n'));
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'smoke OK');
process.exit(0);
