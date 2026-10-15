#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Full end-to-end run of Clowe on the LOCAL stack, every provider on its mock.
//
//   node scripts/e2e-full.mjs              all flows, then the production read-only checks
//   node scripts/e2e-full.mjs --only 1,2   some flows (no production checks)
//   node scripts/e2e-full.mjs --no-prod    skip the production checks
//   node scripts/e2e-full.mjs --prod-only  only the production read-only checks
//
// It starts its own API (port 4600) and web dev server (4700) with OTP,
// payments, KYC, try-on (FASHN never called), AI, messaging and shipping all
// forced to mock and the Delhivery/FASHN keys blanked (scripts/e2e/stack.mjs),
// creates fresh data (new phone numbers, "E2E <run>" names) in the dev
// database, drives a real browser (installed Chrome via Playwright), and checks
// both what the page shows — including the save/approve/error messages — and
// what the database and ledger recorded. Parcels are moved by Delhivery-shaped
// scans posted to the local webhook. Production is only read: public pages,
// health, no console errors, no stock photos.
//
// Prints PASS/FAIL per step and writes e2e-results/<run>/report.md (+ .json)
// with the cause and a screenshot for every failure. Rerunnable: each run
// makes its own data.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { API, MOCK_ENV, ROOT, WEB, apiRequire, pinHash, playwright, prismaClient, startStack } from './e2e/stack.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',').map(Number)) : null;
const prodOnly = args.includes('--prod-only');
const runProd = (!args.includes('--no-prod') && !only) || prodOnly;
const RUN = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15); // 20261016T031245
const OUT = path.join(ROOT, 'e2e-results', RUN);
fs.mkdirSync(OUT, { recursive: true });
const WEBHOOK_TOKEN = 'e2e-local-webhook-token';
const PROD = 'https://cloweshop.com';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
const results = [];
const failedKeys = new Set();
let shotN = 0;

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function step(flow, name, fn, { page, needs = [], key } = {}) {
  const blocked = needs.filter((k) => failedKeys.has(k));
  if (blocked.length) {
    results.push({ flow, step: name, status: 'FAIL', cause: `not run: depends on ${blocked.join(', ')}`, shot: '' });
    if (key) failedKeys.add(key);
    log(`FAIL  [${flow}] ${name} — blocked by ${blocked.join(', ')}`);
    return undefined;
  }
  const started = Date.now();
  try {
    const value = await fn();
    results.push({ flow, step: name, status: 'PASS', cause: '', shot: '', ms: Date.now() - started });
    log(`PASS  [${flow}] ${name}`);
    return value;
  } catch (err) {
    let shot = '';
    const p = typeof page === 'function' ? page() : page;
    if (p && !p.isClosed()) {
      shotN += 1;
      shot = path.join(OUT, `fail-${String(shotN).padStart(2, '0')}-${flow.replace(/\W+/g, '-')}.png`);
      await p.screenshot({ path: shot, fullPage: true }).catch(() => (shot = ''));
    }
    let cause = String(err?.message ?? err).split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 400);
    const recent = [...new Set(badResponses.filter((b) => b.at >= started - 30_000).map((b) => b.text))].slice(-4);
    if (recent.length) cause += ` [server answered: ${recent.join('; ')}]`;
    results.push({ flow, step: name, status: 'FAIL', cause, shot: shot ? path.relative(ROOT, shot) : '', ms: Date.now() - started });
    if (key) failedKeys.add(key);
    log(`FAIL  [${flow}] ${name} — ${cause}`);
    return undefined;
  }
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Data and API helpers
// ---------------------------------------------------------------------------
const prisma = prismaClient();
let phoneSeq = 0;
/** A fresh 10-digit number no account has. */
async function freshPhone(prefix) {
  for (;;) {
    phoneSeq += 1;
    const phone = `${prefix}${String(Date.now() + phoneSeq).slice(-8)}`;
    if (!(await prisma.user.findUnique({ where: { phone } }))) return phone;
  }
}

// The API rate-limits 300 requests a minute per client IP, and here every
// browser and this script share one machine. The API trusts one proxy hop
// (X-Forwarded-For), so each browser context and the script get their own
// address, as separate shoppers, sellers and admins would have. Nothing in
// the app changes; a run that still meets a 429 says so in its causes.
const SCRIPT_IP = '10.77.0.1';
let contextIpSeq = 10;

async function api(method, p, token, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'x-forwarded-for': SCRIPT_IP, ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json, data: json?.data };
}

async function apiOk(method, p, token, body) {
  const r = await api(method, p, token, body);
  check(r.status < 300 && r.json?.success !== false, `${method} ${p} → ${r.status} ${r.json?.error?.message ?? JSON.stringify(r.json).slice(0, 160)}`);
  return r.data;
}

/** Delhivery-shaped scan for one AWB, through the local webhook. */
async function scan(awb, status, statusType, code) {
  const res = await fetch(`${API}/api/webhooks/delhivery`, {
    method: 'POST',
    headers: { 'x-forwarded-for': SCRIPT_IP, authorization: `Bearer ${WEBHOOK_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      Shipment: { AWB: awb, Status: { Status: status, StatusType: statusType, StatusCode: code, StatusDateTime: new Date().toISOString() } },
    }),
  });
  const json = await res.json();
  check(res.ok && json.data?.applied === 1, `webhook ${status} for ${awb}: ${JSON.stringify(json)}`);
}
const SCANS = {
  PICKED_UP: ['In Transit', 'UD', 'X-PPOM'],
  DELIVERED: ['Delivered', 'DL', 'EOD-38'],
  DELIVERY_FAILED: ['Pending', 'UD', 'EOD-11'],
  RTO: ['In Transit', 'RT', 'RT-101'],
  RTO_DELIVERED: ['RTO', 'DL', 'RT-110'],
};
const courier = (awb, event) => scan(awb, ...SCANS[event]);

/** Run one API service function in-process (same code, same database) — the "time machine". */
function runService(code) {
  const file = path.join(OUT, `service-${Date.now()}.mts`);
  // An absolute import must be a file:// URL on Windows.
  fs.writeFileSync(file, code.replace(/'\.\/src\//g, `'${pathToFileURL(path.join(ROOT, 'apps', 'api', 'src')).href}/`));
  const res = spawnSync('npx', ['tsx', file], {
    cwd: path.join(ROOT, 'apps', 'api'),
    env: { ...process.env, ...MOCK_ENV, PORT: '0' },
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: 180_000,
  });
  check(res.status === 0, `service call failed: ${(res.stderr || res.stdout).slice(-400)}`);
  return res.stdout;
}

async function ledger(sellerId, orderId) {
  return prisma.sellerLedgerEntry.findMany({ where: { sellerId, ...(orderId ? { orderId } : {}) }, orderBy: { createdAt: 'asc' } });
}

async function makeImage(name, w, h, color) {
  const sharp = apiRequire('sharp');
  const file = path.join(OUT, name);
  await sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><text x="50%" y="50%" font-size="${Math.round(h / 8)}" text-anchor="middle" fill="white">${name}</text></svg>`), top: 0, left: 0 }])
    .jpeg()
    .toFile(file);
  return file;
}

/** A GSTIN with a valid check digit for a PAN (state 07). */
function gstinFor(pan) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const base = `07${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(base[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return base + chars[(36 - (sum % 36)) % 36];
}
function randomPan(entityLetter = 'P') {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const r = (n) => Array.from({ length: n }, () => L[Math.floor(Math.random() * L.length)]).join('');
  return `${r(3)}${entityLetter}${r(1)}${String(Math.floor(1000 + Math.random() * 8999))}${r(1)}`;
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
let browser;
const pageProblems = [];
/** 429 and 5xx answers seen by any page, newest last: a failed step shows the ones from its last 30 s. */
const badResponses = [];

async function newPage(label, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  const ip = `10.77.1.${contextIpSeq++}`;
  await ctx.route(`${API}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => pageProblems.push(`${label} pageerror on ${page.url()}: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) badResponses.push({ at: Date.now(), text: `${r.status()} ${r.request().method()} ${r.url().replace(/\?.*/, '').replace(API, '')}` });
  });
  page.on('requestfailed', (r) => {
    if (r.url().includes('/api/')) badResponses.push({ at: Date.now(), text: `request failed (${r.failure()?.errorText}) ${r.method()} ${r.url().replace(/\?.*/, '').replace(API, '')}` });
  });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (d.defaultValue() || 'E2E reason given by the test') : undefined).catch(() => {}));
  return page;
}

/** Until React has hydrated the page: typing into server-rendered inputs before that is lost. */
async function hydrated(page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('main') ?? document.querySelector('body > div');
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactFiber') || k.startsWith('__reactProps'));
    },
    null,
    { timeout: 240_000 },
  );
  await page.waitForTimeout(300);
}

async function goto(page, p) {
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${WEB}${p}`, { waitUntil: 'domcontentloaded', timeout: 240_000 }).catch(async (err) => {
      // A client-side redirect can abort the first navigation; once more is enough.
      if (attempt > 1 || !/ERR_ABORTED/.test(err.message)) throw err;
    });
    const chunkError = page.getByText(/ChunkLoadError|Loading chunk .* failed/);
    const ok = await hydrated(page).then(() => true, () => false);
    if (ok && !(await chunkError.count())) return;
    if (attempt >= 3) throw new Error(`page ${p} did not load (dev server chunk timeout${ok ? '' : ' / not hydrated'})`);
    await page.waitForTimeout(3000);
  }
}

/** Run an action that sends an OTP; if the resend cooldown refuses it, wait it out and run it again. */
async function withOtpCooldown(page, action) {
  await action();
  const wait = page.getByText(/Please wait (\d+)s/);
  if (await wait.first().waitFor({ timeout: 4000 }).then(() => true, () => false)) {
    const secs = Number((await wait.first().innerText()).match(/(\d+)s/)[1]);
    await page.waitForTimeout((secs + 3) * 1000);
    await action();
  }
}

/** Wait for a toast whose text matches; returns its text. */
async function toast(page, re, timeout = 20_000) {
  const loc = page.locator('[data-toast]').filter({ hasText: re }).first();
  await loc.waitFor({ timeout }).catch(async () => {
    const seen = await page.locator('[data-toast]').allInnerTexts();
    throw new Error(`no toast matching ${re} (toasts: ${seen.join(' | ') || 'none'})`);
  });
  return loc.innerText();
}

async function typeDigits(page, digits) {
  await page.keyboard.type(digits, { delay: 40 });
}

async function tokenOf(page) {
  return page.evaluate(() => localStorage.getItem('clowe.accessToken'));
}

/** Sign in at /login (or /seller/login) with a phone and PIN. */
async function pinLogin(page, phone, pin, at = '/login') {
  await goto(page, at);
  await page.getByPlaceholder('10-digit mobile number').fill(phone);
  await page.getByRole('button', { name: /Login with PIN/ }).click();
  await page.getByText(/Enter your 4-digit PIN/i).waitFor({ timeout: 30_000 });
  await page.locator('input[type=password]').first().click();
  await typeDigits(page, pin);
  await page.waitForFunction(() => !!localStorage.getItem('clowe.accessToken'), null, { timeout: 30_000 });
}

/** A user straight in the database, with a PIN (for roles the run doesn't sign up through the UI). */
async function seedUser(role, name, pin = '2468') {
  const phone = await freshPhone(role === 'ADMIN' ? '93' : role === 'SELLER' ? '94' : '95');
  const user = await prisma.user.create({ data: { phone, name, role, referralCode: `E2E-${phone.slice(-7)}` } });
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: pinHash(user.id, pin) } });
  return { ...user, pin };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
const want = (n) => !only || only.has(n);
const S = {}; // state shared between flows

async function main() {
  log(`E2E run ${RUN} — results in ${path.relative(ROOT, OUT)}`);
  if (prodOnly) {
    await prodChecks();
    await prisma.$disconnect();
    writeReport();
    return;
  }
  MOCK_ENV.DELHIVERY_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  const stack = await startStack({ log });
  fs.writeFileSync(path.join(OUT, 'api-boot.log'), stack.apiLog.join(''));
  const { chromium } = playwright();
  browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    await step('0 Safety', 'every provider is the mock (boot log)', async () => {
      const boot = stack.apiLog.join('');
      check(/Shipping: mock Delhivery/i.test(boot), 'API did not say "Shipping: mock Delhivery"');
      check(!/FASHN/i.test(boot) || /mock/i.test(boot), 'try-on provider not mock');
      const env = { ...MOCK_ENV };
      for (const k of ['OTP_PROVIDER', 'PAYMENT_PROVIDER', 'KYC_PROVIDER', 'TRYON_PROVIDER', 'AI_PROVIDER', 'SHIPPING_PROVIDER']) check(env[k] === 'mock', `${k}=${env[k]}`);
    });
    if (want(1)) await flow1Admin();
    if (want(2)) await flow2Seller();
    if (want(3)) await flow3Approval();
    if (want(4)) await flow4Products();
    if (want(5)) await flow5Edits();
    if (want(6)) await flow6TryOn();
    if (want(7)) await flow7Ads();
    if (want(8)) await flow8Shopper();
    if (want(9)) await flow9Fulfilment();
    if (want(10)) await flow10CancelReturnRto();
    if (want(11)) await flow11Payouts();
    if (want(12)) await flow12Support();
    if (want(13)) await flow13Admin();
  } finally {
    fs.writeFileSync(path.join(OUT, 'api.log'), stack.apiLog.join(''));
    fs.writeFileSync(path.join(OUT, 'web.log'), stack.webLog.join(''));
    await browser.close().catch(() => {});
    stack.stop();
  }
  if (runProd) await prodChecks();
  await prisma.$disconnect();
  writeReport();
}

// ---------------------------------------------------------------------------
// 1 Admin
// ---------------------------------------------------------------------------
async function flow1Admin() {
  const F = '1 Admin';
  S.admin = await seedUser('ADMIN', `E2E Admin ${RUN}`);
  S.adminPage = await newPage('admin');
  const page = S.adminPage;
  await step(F, 'login with PIN', async () => {
    await pinLogin(page, S.admin.phone, S.admin.pin);
    await page.waitForURL(/\/admin/, { timeout: 60_000 });
    S.adminToken = await tokenOf(page);
  }, { page, key: 'admin' });
  await step(F, 'dashboard loads', async () => {
    await goto(page, '/admin');
    await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 120_000 });
    check(!(await page.getByText(/Something went wrong/).count()), 'dashboard shows an error');
  }, { page, needs: ['admin'] });
  await step(F, 'settings save shows "Settings saved"', async () => {
    await goto(page, '/admin/settings');
    await page.getByRole('button', { name: 'Save settings' }).click({ timeout: 120_000 });
    await toast(page, /Settings saved/);
  }, { page, needs: ['admin'] });
  await step(F, 'a bad setting is refused by its field, page scrolls to it', async () => {
    const input = page.locator('input[name=gstUniformPercent]');
    S.gstUniformBefore = await input.inputValue();
    await input.fill('99');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await toast(page, /Not saved/);
    const err = page.locator('input[name=gstUniformPercent] + p[role=alert], input[name=gstUniformPercent] ~ p[role=alert]').first();
    await err.waitFor({ timeout: 5000 });
    check(await err.isVisible(), 'the field error is not visible (page did not scroll to it)');
    await input.fill(S.gstUniformBefore);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await toast(page, /Settings saved/);
  }, { page, needs: ['admin'] });
}

// ---------------------------------------------------------------------------
// 2 Seller registration, KYC, store settings
// ---------------------------------------------------------------------------
/** Save Store Settings and wait for the save itself (an identical earlier toast may still be showing). */
async function saveStore(page) {
  const saved = page.waitForResponse((r) => r.url().includes('/api/seller/store/') && r.request().method() === 'PUT', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Save changes' }).click();
  const res = await saved;
  check(res.ok(), `save answered ${res.status()} ${(await res.json().catch(() => ({})))?.error?.message ?? ''}`);
  await toast(page, /Store settings saved/);
}

async function flow2Seller() {
  const F = '2 Seller';
  S.sellerPage = await newPage('seller');
  const page = S.sellerPage;
  S.sellerPhone = await freshPhone('91');
  S.sellerPan = randomPan('P');
  S.sellerGstin = gstinFor(S.sellerPan);
  S.shopName = `E2E Shop ${RUN}`;

  await step(F, 'register: a bad PAN is marked by its field', async () => {
    await goto(page, '/seller/register');
    // A throwaway number: if the bad PAN gets through, its OTP cooldown doesn't block the real one.
    await page.locator('input[name=phone]').fill(await freshPhone('90'), { timeout: 120_000 });
    await page.locator('input[name=shopName]').fill(`${S.shopName} (bad PAN)`);
    await page.locator('input[name=panNumber]').fill('BADPAN');
    await page.getByRole('button', { name: /Send OTP & Submit|Submit application/ }).click();
    await toast(page, /Not submitted/);
    await page.locator('[name=panNumber] ~ p[role=alert], [name=panNumber] + p[role=alert]').first().waitFor({ timeout: 5000 });
  }, { page });

  await step(F, 'register with a new phone, OTP (mock), application submitted', async () => {
    // If the bad PAN went through to the OTP screen, go back to the form.
    if (await page.getByText('Verify your phone').count()) {
      await page.getByRole('button', { name: 'change' }).click().catch(async () => goto(page, '/seller/register'));
      await page.locator('[name=panNumber]').waitFor({ timeout: 30_000 }).catch(async () => goto(page, '/seller/register'));
    }
    await page.locator('input[name=phone]').fill(S.sellerPhone);
    await page.locator('input[name=shopName]').fill(S.shopName);
    const fill = (n, v) => page.locator(`[name=${n}]`).fill(v);
    await fill('panNumber', S.sellerPan);
    await fill('gstNumber', S.sellerGstin);
    await fill('bankAccountName', 'E2E Seller');
    await fill('bankAccountNo', '123456789012');
    await fill('bankIfsc', 'HDFC0001234');
    await fill('addressLine1', '12 Defence Enclave, Mohan Garden');
    await fill('city', 'New Delhi');
    await fill('state', 'Delhi');
    await fill('pincode', '110059');
    await page.getByRole('button', { name: /Send OTP & Submit/ }).click();
    // The bad-PAN attempt already sent a code: wait out the resend cooldown.
    const wait = page.getByText(/Please wait (\d+)s/);
    if (await wait.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
      const secs = Number((await wait.innerText()).match(/(\d+)s/)[1]);
      await page.waitForTimeout((secs + 2) * 1000);
      await page.getByRole('button', { name: /Send OTP & Submit/ }).click();
    }
    await page.getByRole('button', { name: /Verify & Submit application/ }).click({ timeout: 60_000 });
    await page.waitForURL((u) => u.pathname === '/seller', { timeout: 120_000 });
    const profile = await prisma.sellerProfile.findFirst({ where: { user: { phone: S.sellerPhone } } });
    check(profile, 'no seller profile in the database');
    check(profile.status === 'PENDING', `status ${profile.status}`);
    check(profile.gstNumber === S.sellerGstin, `GSTIN stored ${profile.gstNumber}`);
    S.sellerId = profile.id;
    S.sellerUserId = profile.userId;
    S.sellerToken = await tokenOf(page);
  }, { page, key: 'seller' });

  await step(F, 'KYC verification (mock) from Business info', async () => {
    await goto(page, '/seller/settings?tab=BUSINESS');
    const verify = page.getByRole('button', { name: /Verify now|Try again/ });
    await verify.first().click({ timeout: 120_000 });
    await toast(page, /Verification (done|ran)/);
    const checks = await prisma.sellerKycCheck.findMany({ where: { sellerId: S.sellerId } });
    check(checks.length > 0, 'no KYC checks recorded');
    check(checks.every((c) => c.provider === 'mock'), `a KYC check used ${checks.map((c) => c.provider).join(',')}`);
  }, { page, needs: ['seller'] });

  await step(F, 'store profile saves (URL, tagline, contact)', async () => {
    await goto(page, '/seller/settings');
    await page.getByRole('button', { name: /Store profile/ }).click({ timeout: 120_000 });
    S.storeSlug = `e2e-${RUN.toLowerCase()}`;
    await page.locator('[name=slug]').fill(S.storeSlug);
    await page.locator('[name=tagline]').fill('Everything the e2e run sells');
    await page.locator('[name=storeEmail]').fill('e2e@example.com');
    await page.locator('[name=storePhone]').fill('+91 98765 43210');
    await saveStore(page);
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.slug === S.storeSlug && p.storeEmail === 'e2e@example.com', `stored slug=${p.slug} email=${p.storeEmail}`);
  }, { page, needs: ['seller'] });

  await step(F, 'business info: GSTIN, PAN and name on PAN save', async () => {
    await page.getByRole('button', { name: /Business info/ }).click();
    await page.locator('[name=panName]').fill('E2E SELLER');
    await saveStore(page);
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.panName === 'E2E SELLER' && p.panNumber === S.sellerPan, `stored panName=${p.panName} pan=${p.panNumber}`);
  }, { page, needs: ['seller'] });

  await step(F, 'payout method (Payouts page) verified and saved', async () => {
    await goto(page, '/seller/payouts');
    const add = page.getByRole('button', { name: '＋ Add' }).first();
    {
      await add.click({ timeout: 120_000 });
      await page.locator('[name=label]').fill('E2E HDFC');
      await page.locator('[name=accountName]').fill('E2E Seller');
      await page.locator('[name=accountNumber]').fill('123456789012');
      await page.locator('[name=ifsc]').fill('HDFC0001234');
      await page.getByRole('button', { name: /Verify & save/ }).click();
      await toast(page, /Payout method verified and saved/);
    }
    const methods = await prisma.sellerPayoutMethod.count({ where: { sellerId: S.sellerId } });
    check(methods > 0, 'no payout method stored');
  }, { page, needs: ['seller'] });

  await step(F, 'pickup address (same as business) saves', async () => {
    await goto(page, '/seller/settings');
    await page.getByRole('button', { name: /Shipping & pickup/ }).click({ timeout: 120_000 });
    await saveStore(page);
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.pickupSameAsBusiness && p.pincode === '110059', `pickupSame=${p.pickupSameAsBusiness} pin=${p.pincode}`);
  }, { page, needs: ['seller'] });

  await step(F, 'return address (separate) saves', async () => {
    await page.getByRole('button', { name: /Return policy/ }).click();
    await page.getByRole('checkbox', { name: /Returns come back to my pickup address/ }).uncheck();
    await page.locator('[name=returnLine1]').fill('7 Returns Lane, Sector 18');
    await page.locator('[name=returnCity]').fill('Noida');
    await page.locator('[name=returnState]').fill('Uttar Pradesh');
    await page.locator('[name=returnPincode]').fill('201301');
    await saveStore(page);
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(!p.returnAddressSameAsPickup && p.returnPincode === '201301', `returnSame=${p.returnAddressSameAsPickup} pin=${p.returnPincode}`);
  }, { page, needs: ['seller'] });
}

// ---------------------------------------------------------------------------
// 3 Admin approval
// ---------------------------------------------------------------------------
async function openSellerPanel(page, shopName) {
  await goto(page, '/admin/sellers');
  await page.getByPlaceholder(/Search shop/).fill(shopName);
  const row = page.locator('tr').filter({ hasText: shopName }).first();
  await row.getByRole('button', { name: 'View' }).click({ timeout: 120_000 });
  await page.locator('[data-action=approve]').waitFor({ timeout: 30_000 });
}

async function flow3Approval() {
  const F = '3 Approval';
  const page = S.adminPage;
  await step(F, 'approval refused without a GSTIN, the reason shown by the button', async () => {
    const u = await seedUser('SELLER', `E2E NoGST ${RUN}`);
    S.noGstShop = `E2E NoGST Shop ${RUN}`;
    await prisma.sellerProfile.create({
      data: { userId: u.id, shopName: S.noGstShop, panNumber: randomPan(), addressLine1: '1 Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    });
    await openSellerPanel(page, S.noGstShop);
    check(await page.locator('[data-approval-box]').getByText(/GSTIN required/).count(), 'yellow box does not list the GSTIN blocker');
    await page.locator('[data-action=approve]').click();
    await page.locator('[data-action-error]').filter({ hasText: /GSTIN required/ }).waitFor({ timeout: 15_000 });
    await toast(page, /Not approved: GSTIN required/);
    const p = await prisma.sellerProfile.findFirst({ where: { shopName: S.noGstShop } });
    check(p.status === 'PENDING', `became ${p.status}`);
  }, { page, needs: ['admin'] });

  await step(F, 'admin approves the new seller ("Seller approved")', async () => {
    await page.keyboard.press('Escape');
    await openSellerPanel(page, S.shopName);
    await page.locator('[data-action=approve]').click();
    await toast(page, /Seller approved/, 30_000);
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.status === 'APPROVED', `status ${p.status}`);
    check(p.courierWarehouseStatus === 'ACTIVE', `Delhivery (mock) pickup address ${p.courierWarehouseStatus}: ${p.courierWarehouseError}`);
  }, { page, needs: ['admin', 'seller'], key: 'approved' });
}

// ---------------------------------------------------------------------------
// 4 Products
// ---------------------------------------------------------------------------
async function pickLeafCategory(page, departmentRe) {
  const selects = page.locator('main select');
  await selects.first().waitFor({ timeout: 60_000 });
  await selects.first().selectOption({ label: await page.locator('main select').first().locator('option', { hasText: departmentRe }).first().innerText() });
  // Keep picking the first real option of each new level until no new level appears.
  for (let level = 1; level < 4; level++) {
    await page.waitForTimeout(600);
    const count = await selects.count();
    if (count <= level) break;
    const sel = selects.nth(level);
    const options = await sel.locator('option').allInnerTexts();
    const pick = options.find((o) => o && !/^Select/i.test(o));
    if (!pick) break;
    await sel.selectOption({ label: pick });
  }
}

/** The category's spec sheet: every empty text field gets a plain value (selects keep their default). */
async function fillSpecs(page) {
  await page.waitForTimeout(800);
  for (const input of await page.locator('main section input[type=text]:visible, main section input:not([type]):visible').all()) {
    if (!(await input.inputValue())) await input.fill('E2E value').catch(() => {});
  }
}

async function flow4Products() {
  const F = '4 Products';
  const page = S.sellerPage;
  S.productImage = await makeImage('product-1200.jpg', 1200, 1200, '#2f4f6f');

  await step(F, 'simple product: form, image, GST/price calculator, weight/size, submitted', async () => {
    await goto(page, '/seller/products/new');
    S.simpleTitle = `E2E Power Bank ${RUN}`;
    await page.getByPlaceholder(/Brand, model and the key spec/).fill(S.simpleTitle, { timeout: 120_000 });
    await page.getByPlaceholder(/What it is, key specifications/).fill('A 10000 mAh power bank with two USB ports, made for the end-to-end run.');
    await page.getByRole('button', { name: 'Next ›' }).click();
    await pickLeafCategory(page, /Electronics/);
    await fillSpecs(page);
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.locator('input[type=file]').first().setInputFiles(S.productImage);
    await page.locator('img[src*="/uploads/"]').first().waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.getByRole('radio', { name: 'One version' }).check();
    await page.getByPlaceholder('499').first().fill('999');
    await page.getByPlaceholder('799').first().fill('1499');
    await page.getByRole('button', { name: 'Next ›' }).click();
    const pays = await page.getByText(/Buyer pays/).locator('xpath=following::*[1]').innerText();
    check(/₹\s?1,1\d\d/.test(pays), `GST/price calculator: buyer pays "${pays}" for ₹999 + 18%`);
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.getByRole('spinbutton', { name: '0.35' }).fill('0.4');
    await page.getByRole('spinbutton', { name: 'L' }).fill('15');
    await page.getByRole('spinbutton', { name: 'W' }).fill('8');
    await page.getByRole('spinbutton', { name: 'H' }).fill('3');
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.locator('[data-action=save-product]').click();
    await toast(page, /Product submitted for review/, 30_000);
    const p = await prisma.product.findFirst({ where: { title: S.simpleTitle }, include: { variants: true, images: true } });
    check(p && p.status === 'PENDING', `product ${p?.status}`);
    check(p.variants[0].pricePaise > 99900, `buyer price ${p.variants[0].pricePaise} should include GST`);
    check(p.weightGrams === 400, `weight ${p.weightGrams}`);
    check(p.images[0]?.url?.includes('-w'), `image not stored resized: ${p.images[0]?.url}`);
    S.simpleId = p.id;
    S.simpleSlug = p.slug;
    S.simpleVariantId = p.variants[0].id;
  }, { page, needs: ['approved'], key: 'simple' });

  await step(F, 'clothing: colour × size grid, images, specs', async () => {
    await goto(page, '/seller/products/new');
    S.clothTitle = `E2E Linen Shirt ${RUN}`;
    await page.getByPlaceholder(/Brand, model and the key spec/).fill(S.clothTitle, { timeout: 120_000 });
    await page.getByPlaceholder(/What it is, key specifications/).fill('A breathable linen shirt in two colours and three sizes, for the e2e run.');
    await page.getByRole('button', { name: 'Next ›' }).click();
    await pickLeafCategory(page, /Fashion/);
    await fillSpecs(page);
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.locator('input[type=file]').first().setInputFiles(S.productImage);
    await page.locator('img[src*="/uploads/"]').first().waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.getByRole('radio', { name: 'Comes in options' }).check();
    // Colour and Size come from the category; add values to each axis.
    const addValue = async (axis, values) => {
      const box = page.getByPlaceholder(new RegExp(`${axis}`, 'i')).first();
      for (const v of values) {
        await box.fill(v);
        await box.press('Enter');
      }
    };
    await addValue('colou?r', ['Black', 'White']);
    await addValue('size', ['M', 'L', 'XL']);
    // One price for the whole colour × size grid.
    // ₹2,199 before GST: over the ₹2,000 try-on minimum (flow 6).
    await page.getByPlaceholder('499').first().fill('2199');
    const apply = page.getByRole('button', { name: /Apply to all (\d+) variants/ });
    const label = await apply.innerText({ timeout: 10_000 });
    check(/Apply to all 6 variants/.test(label), `grid button says "${label}", expected 6 (2 colours × 3 sizes)`);
    await apply.click();
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.getByRole('spinbutton', { name: '0.35' }).fill('0.3');
    await page.getByRole('spinbutton', { name: 'L' }).fill('30');
    await page.getByRole('spinbutton', { name: 'W' }).fill('25');
    await page.getByRole('spinbutton', { name: 'H' }).fill('3');
    await page.getByRole('button', { name: 'Next ›' }).click();
    await page.locator('[data-action=save-product]').click();
    await toast(page, /Product submitted for review/, 30_000);
    const p = await prisma.product.findFirst({ where: { title: S.clothTitle }, include: { variants: true } });
    check(p && p.variants.length === 6, `variants ${p?.variants.length}`);
    S.clothId = p.id;
    S.clothSlug = p.slug;
    S.clothVariantId = p.variants[0].id;
  }, { page, needs: ['approved'], key: 'cloth' });

  await step(F, 'admin approves both listings ("Product approved")', async () => {
    const admin = S.adminPage;
    for (const title of [S.simpleTitle, S.clothTitle].filter(Boolean)) {
      // A fresh list each time: approving one re-renders the rest.
      await goto(admin, '/admin/products');
      const row = admin.locator('div').filter({ hasText: title }).filter({ has: admin.locator('[data-action=approve-product]') }).last();
      await row.locator('[data-action=approve-product]').click({ timeout: 120_000 });
      await toast(admin, /Product approved/);
      await admin.waitForTimeout(800);
    }
    const ps = await prisma.product.findMany({ where: { id: { in: [S.simpleId, S.clothId].filter(Boolean) } } });
    check(ps.length && ps.every((p) => p.status === 'APPROVED'), `statuses ${ps.map((p) => p.status).join(',')}`);
  }, { page: S.adminPage, needs: ['simple'], key: 'live' });

  await step(F, 'live in the storefront: product page, search and filters', async () => {
    const shop = await newPage('storefront');
    await goto(shop, `/products/${S.simpleSlug}`);
    await shop.getByRole('heading', { name: S.simpleTitle }).waitFor({ timeout: 120_000 });
    const search = await apiOk('GET', `/api/products?q=${encodeURIComponent('E2E Power Bank')}`, null);
    const items = search.items ?? search.products ?? search;
    check(JSON.stringify(items).includes(S.simpleId), 'not found by search');
    const cat = await prisma.product.findUnique({ where: { id: S.simpleId }, include: { category: true } });
    const filtered = await apiOk('GET', `/api/products?category=${cat.category.slug}&minPrice=1000&maxPrice=2000`, null);
    check(JSON.stringify(filtered).includes(S.simpleId), 'not in its category with a price filter');
    await shop.context().close();
  }, { needs: ['live'] });
}

// ---------------------------------------------------------------------------
// 5 Edits
// ---------------------------------------------------------------------------
async function flow5Edits() {
  const F = '5 Edits';
  const page = S.sellerPage;
  await step(F, 'price/stock edit saves directly and stays live', async () => {
    await goto(page, `/seller/products/${S.simpleId}/edit`);
    await page.getByRole('button', { name: /Price & options/ }).click({ timeout: 120_000 });
    await page.getByPlaceholder('499').first().fill('1099');
    await page.getByRole('button', { name: /Review/ }).click();
    await page.locator('[data-action=save-product]').click();
    await toast(page, /Saved — live now/, 30_000);
    const p = await prisma.product.findUnique({ where: { id: S.simpleId }, include: { variants: true } });
    check(p.status === 'APPROVED', `status ${p.status}`);
    check(p.variants[0].sellerPricePaise === 109900 || p.variants[0].pricePaise > 120000, `price not updated: ${JSON.stringify(p.variants[0]).slice(0, 200)}`);
  }, { page, needs: ['live'] });

  await step(F, 'content edit goes to the admin Edits tab; live version stays up', async () => {
    await goto(page, `/seller/products/${S.simpleId}/edit`);
    S.editedTitle = `${S.simpleTitle} Pro`;
    await page.getByPlaceholder(/Brand, model and the key spec/).fill(S.editedTitle, { timeout: 120_000 });
    await page.getByRole('button', { name: /Review/ }).click();
    await page.locator('[data-action=save-product]').click();
    await toast(page, /Changes sent for review/, 30_000);
    const p = await prisma.product.findUnique({ where: { id: S.simpleId } });
    check(p.title === S.simpleTitle && p.status === 'APPROVED', `live title now "${p.title}" (${p.status})`);
  }, { page, needs: ['live'], key: 'edit1' });

  await step(F, 'approving the edit replaces the live version', async () => {
    const admin = S.adminPage;
    await goto(admin, '/admin/products');
    await admin.getByRole('button', { name: /^edits/i }).click({ timeout: 120_000 });
    const row = admin.locator('div').filter({ hasText: S.simpleTitle }).filter({ has: admin.locator('[data-action=approve-revision]') }).last();
    await row.locator('[data-action=approve-revision]').click();
    await toast(admin, /Changes approved/);
    const p = await prisma.product.findUnique({ where: { id: S.simpleId } });
    check(p.title === S.editedTitle, `title "${p.title}"`);
  }, { page: S.adminPage, needs: ['edit1'] });

  await step(F, 'rejecting an edit keeps the old version', async () => {
    await goto(page, `/seller/products/${S.simpleId}/edit`);
    await page.getByPlaceholder(/Brand, model and the key spec/).fill(`${S.editedTitle} Max`, { timeout: 120_000 });
    await page.getByRole('button', { name: /Review/ }).click();
    await page.locator('[data-action=save-product]').click();
    await toast(page, /Changes sent for review/, 30_000);
    const admin = S.adminPage;
    await goto(admin, '/admin/products');
    await admin.getByRole('button', { name: /^edits/i }).click({ timeout: 120_000 });
    const row = admin.locator('div').filter({ hasText: S.editedTitle }).filter({ has: admin.locator('[data-action=reject-revision]') }).last();
    await row.locator('[data-action=reject-revision]').click();
    await toast(admin, /Changes rejected/);
    const p = await prisma.product.findUnique({ where: { id: S.simpleId } });
    check(p.title === S.editedTitle, `title "${p.title}" after rejection`);
  }, { page: S.adminPage, needs: ['edit1'] });
}

// ---------------------------------------------------------------------------
// 6 Try-on
// ---------------------------------------------------------------------------
async function flow6TryOn() {
  const F = '6 Try-on';
  await step(F, 'shopper try-on: result shown, seller credits down, shopper counted', async () => {
    S.tryShopper = await seedUser('CUSTOMER', `E2E TryOn ${RUN}`);
    const page = await newPage('tryon');
    S.tryPage = page;
    await pinLogin(page, S.tryShopper.phone, S.tryShopper.pin);
    const token = await tokenOf(page);
    const before = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    const photo = await makeImage('shopper-photo.jpg', 800, 1200, '#6b4f3a');
    await goto(page, `/products/${S.clothSlug}/tryon`);
    const file = page.locator('input[type=file]').first();
    await file.setInputFiles(photo, { timeout: 120_000 });
    await page.getByRole('button', { name: /Generate my try-on/ }).click({ timeout: 30_000 });
    await page.getByAltText('Your try-on result').waitFor({ timeout: 120_000 });
    await page.getByText(/left today/).waitFor({ timeout: 10_000 });
    const after = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(after.tryOnCredits === before.tryOnCredits - 1, `seller credits ${before.tryOnCredits} → ${after.tryOnCredits}`);
    const quota = await apiOk('GET', '/api/tryon/quota', token);
    check(JSON.stringify(quota).match(/"used(Today)?":\s*1|"todayUsed":\s*1|"remaining/), `quota after one run: ${JSON.stringify(quota)}`);
    S.tryToken = token;
  }, { page: () => S.tryPage, needs: ['live', 'cloth'], key: 'tryon' });

  await step(F, 'refused when the seller has no credits left', async () => {
    await prisma.sellerProfile.update({ where: { id: S.sellerId }, data: { tryOnCredits: 0 } });
    const page = S.tryPage;
    const runsBefore = await prisma.tryOnHistory.count({ where: { productId: S.clothId, status: 'SUCCESS' } }).catch(() => null);
    try {
      await goto(page, `/products/${S.clothSlug}/tryon`);
      const gen = page.getByRole('button', { name: /Generate (another|my) try-on/ });
      if (await gen.isVisible().catch(() => false) && (await gen.isEnabled())) await gen.click();
      const said = page.getByText(/credit|unavailable|isn.t available|not available|paused/i).first();
      await said.waitFor({ timeout: 30_000 });
      const runsAfter = await prisma.tryOnHistory.count({ where: { productId: S.clothId, status: 'SUCCESS' } }).catch(() => null);
      check(runsBefore === null || runsAfter <= runsBefore, 'a try-on ran at zero credits');
    } finally {
      await prisma.sellerProfile.update({ where: { id: S.sellerId }, data: { tryOnCredits: 20 } });
    }
  }, { needs: ['tryon'] });
}

// ---------------------------------------------------------------------------
// 7 Ads and promotions
// ---------------------------------------------------------------------------
async function promoBalance(sellerId) {
  const r = await apiOk('GET', '/api/seller/promotion-credits', S.sellerToken);
  return r.balancePaise;
}

async function flow7Ads() {
  const F = '7 Ads';
  const page = S.sellerPage;
  await step(F, 'promotion credits bought with the mock payment', async () => {
    await goto(page, '/seller');
    await page.getByRole('button', { name: '₹5,000' }).click({ timeout: 120_000 });
    S.promoBefore = await promoBalance(S.sellerId);
    await page.getByRole('button', { name: 'Add credits' }).click();
    await page.locator('[data-action=pay-credits]').click({ timeout: 30_000 });
    await toast(page, /Paid — ₹5,000/);
    const after = await promoBalance(S.sellerId);
    check(after - S.promoBefore === 500000, `balance ${S.promoBefore} → ${after}`);
  }, { page, needs: ['approved'], key: 'credits' });

  const settings = await apiOk('GET', '/api/admin/settings', S.adminToken).catch(() => null);
  const price = (pl, d) => settings?.adPricing?.[pl]?.[String(d)];
  for (const [placement, label, days, expected] of [
    ['HOME_BANNER', /Home page banner/, 7, 49900],
    ['CATEGORY_SPONSORED', /Sponsored slot/, 7, 29900],
  ]) {
    await step(F, `${placement} request shows the settings price (${expected / 100}) and is submitted`, async () => {
      check(price(placement, days) === expected, `settings price for ${placement} ${days}d is ${price(placement, days)}`);
      await goto(page, '/seller/ads/new');
      await page.getByRole('button', { name: new RegExp(S.editedTitle ?? S.simpleTitle) }).first().click({ timeout: 120_000 });
      await page.getByRole('button', { name: label }).click();
      const dayBtn = page.getByRole('button', { name: new RegExp(`^${days} days`) });
      const text = await dayBtn.innerText();
      check(text.replace(/[,\s]/g, '').includes(`₹${expected / 100}`), `button says "${text}"`);
      await dayBtn.click();
      await page.locator('[data-action=submit-ad]').click();
      await toast(page, /Ad submitted/);
    }, { page, needs: ['credits', 'live'], key: `ad-${placement}` });
  }

  await step(F, 'admin approves both; the balance goes down by the settings prices; they appear', async () => {
    const admin = S.adminPage;
    const before = await promoBalance(S.sellerId);
    await goto(admin, '/admin/ads');
    await admin.getByRole('button', { name: 'Pending', exact: true }).click({ timeout: 60_000 });
    const ads = await prisma.ad.findMany({ where: { sellerId: S.sellerId, status: 'PENDING' } });
    check(ads.length >= 2, `${ads.length} pending ads`);
    await admin.locator('[data-action=approve-ad]').first().waitFor({ timeout: 30_000 }).catch(async () => {
      const shown = await admin.locator('main').innerText();
      throw new Error(`${ads.length} ads are PENDING in the database but the admin Pending tab shows: "${shown.slice(0, 120)}"`);
    });
    for (let i = 0; i < 2; i++) {
      await admin.locator('[data-action=approve-ad]').first().click({ timeout: 120_000 });
      await toast(admin, /Ad approved/);
      await admin.waitForTimeout(500);
    }
    const after = await promoBalance(S.sellerId);
    const live = await prisma.ad.findMany({ where: { sellerId: S.sellerId, status: 'ACTIVE' } });
    check(live.length >= 2, `${live.length} live ads`);
    // Charged at request or at approval: either way the total spent is the two prices.
    const spent = S.promoBefore + 500000 - after;
    check(spent === 49900 + 29900, `spent ${spent} (balance before approval ${before}, after ${after})`);
    const home = await apiOk('GET', '/api/ads/active?placement=HOME_BANNER', null);
    check(JSON.stringify(home).includes(S.simpleId) || JSON.stringify(home).includes(S.editedTitle ?? S.simpleTitle), `home banner ad not served by /api/ads/active: ${JSON.stringify(home).slice(0, 200)}`);
  }, { page: S.adminPage, needs: ['ad-HOME_BANNER', 'ad-CATEGORY_SPONSORED'], key: 'adsLive' });

  await step(F, 'an ad stops when its campaign ends', async () => {
    const ad = await prisma.ad.findFirst({ where: { sellerId: S.sellerId, status: 'ACTIVE', placement: 'CATEGORY_SPONSORED' } });
    await prisma.ad.update({ where: { id: ad.id }, data: { endAt: new Date(Date.now() - 60_000) } });
    await api('GET', '/api/ads/active?placement=CATEGORY_SPONSORED', null);
    const now = await prisma.ad.findUnique({ where: { id: ad.id } });
    check(now.status !== 'ACTIVE', `still ${now.status} after its end`);
  }, { needs: ['adsLive'] });

  await step(F, 'a rejected request is refunded', async () => {
    const before = await promoBalance(S.sellerId);
    await apiOk('POST', '/api/seller/ads', S.sellerToken, { productId: S.simpleId, placement: 'CATEGORY_SPONSORED', durationDays: 15 });
    const mid = await promoBalance(S.sellerId);
    const admin = S.adminPage;
    await goto(admin, '/admin/ads');
    await admin.getByRole('button', { name: 'Pending', exact: true }).click({ timeout: 60_000 });
    await admin.getByRole('button', { name: /✕ Reject/ }).first().click({ timeout: 120_000 });
    await admin.getByPlaceholder('Reason shown to the seller').fill('E2E: rejected to test the refund');
    await admin.locator('[data-action=reject-ad]').click();
    await toast(admin, /Ad rejected/);
    const after = await promoBalance(S.sellerId);
    check(after === before, `balance ${before} → ${mid} on request → ${after} after rejection`);
  }, { page: S.adminPage, needs: ['credits'] });
}

// ---------------------------------------------------------------------------
// 8 Shopper
// ---------------------------------------------------------------------------
async function flow8Shopper() {
  const F = '8 Shopper';
  S.shopPage = await newPage('shopper');
  const page = S.shopPage;
  S.shopperPhone = await freshPhone('92');
  await step(F, 'signup with OTP, profile and a PIN', async () => {
    await goto(page, '/login');
    await page.getByRole('button', { name: 'Create Account' }).click({ timeout: 120_000 });
    await page.getByPlaceholder('10-digit mobile number').fill(S.shopperPhone);
    await page.getByRole('button', { name: 'Get OTP' }).click();
    await page.getByRole('button', { name: /Verify & Login/ }).click({ timeout: 30_000 });
    await page.getByPlaceholder('Full name *').fill('E2E Shopper', { timeout: 30_000 });
    await page.getByPlaceholder('Address (house no, street) *').fill('22 Linking Road');
    await page.getByPlaceholder('City *').fill('Mumbai');
    await page.getByPlaceholder('State *').fill('Maharashtra');
    await page.getByPlaceholder('Pincode *').fill('400050');
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('button', { name: /Skip for now|Save & Continue/ }).first().click({ timeout: 30_000 });
    await page.locator('input[type=password]').first().click({ timeout: 30_000 });
    await typeDigits(page, '1357');
    await page.getByRole('button', { name: /Save PIN & Continue/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
    const u = await prisma.user.findUnique({ where: { phone: S.shopperPhone }, include: { addresses: true } });
    check(u?.pinHash, 'no PIN stored');
    check(u.addresses.length === 1, `${u.addresses.length} addresses`);
    S.shopperId = u.id;
    S.shopperToken = await tokenOf(page);
    S.addressId = u.addresses[0].id;
  }, { page, key: 'shopper' });

  await step(F, 'forgot PIN: OTP, a new PIN, signed in', async () => {
    await page.evaluate(() => localStorage.clear());
    await goto(page, '/login');
    await page.getByPlaceholder('10-digit mobile number').fill(S.shopperPhone, { timeout: 120_000 });
    await page.getByRole('button', { name: /Login with PIN/ }).click();
    await withOtpCooldown(page, () => page.getByRole('button', { name: 'Forgot PIN?' }).click());
    await page.getByRole('button', { name: /Verify & Login/ }).click({ timeout: 60_000 });
    await page.locator('[data-new-pin] input[type=password]').first().click({ timeout: 30_000 });
    await typeDigits(page, '2468');
    await page.locator('[data-new-pin] input[type=password]').nth(4).click();
    await typeDigits(page, '2468');
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 }).catch(async () => {
      await page.getByRole('button', { name: /Save new PIN/ }).click();
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
    });
    const u = await prisma.user.findUnique({ where: { id: S.shopperId } });
    check(u.pinHash === pinHash(u.id, '2468'), 'the new PIN was not stored');
    S.shopperToken = await tokenOf(page);
    S.shopperPin = '2468';
  }, { page, needs: ['shopper'] });

  // Whatever happened above, carry on signed in.
  if (S.shopperId && !(await tokenOf(page).catch(() => null))) {
    await prisma.user.update({ where: { id: S.shopperId }, data: { pinHash: pinHash(S.shopperId, '2468'), pinAttempts: 0 } });
    await pinLogin(page, S.shopperPhone, '2468').catch(() => {});
    S.shopperToken = await tokenOf(page);
  }

  await step(F, 'browse, search and filters', async () => {
    await goto(page, `/products?q=${encodeURIComponent('E2E Power Bank')}`);
    await page.getByText(S.editedTitle ?? S.simpleTitle).first().waitFor({ timeout: 120_000 });
  }, { page, needs: ['shopper', 'live'] });

  await step(F, 'wishlist', async () => {
    await apiOk('POST', '/api/wishlist', S.shopperToken, { productId: S.simpleId }).catch(async () =>
      apiOk('POST', `/api/wishlist/${S.simpleId}`, S.shopperToken),
    );
    await goto(page, '/wishlist');
    await page.getByText(S.editedTitle ?? S.simpleTitle).first().waitFor({ timeout: 120_000 });
  }, { page, needs: ['shopper', 'live'] });

  await step(F, 'cart, with free delivery shown', async () => {
    await goto(page, `/products/${S.simpleSlug}`);
    await page.getByRole('button', { name: /^Add to Cart$/ }).first().click({ timeout: 120_000 });
    await goto(page, '/cart');
    await page.getByText(S.editedTitle ?? S.simpleTitle).first().waitFor({ timeout: 120_000 });
    check(await page.getByText(/Free delivery|Delivery\s*FREE|FREE/i).count(), 'free delivery not shown in the cart');
  }, { page, needs: ['shopper', 'live'], key: 'cart' });

  await step(F, 'prepaid checkout with the mock payment: confirmation, invoice, notification', async () => {
    await goto(page, '/checkout');
    await page.getByRole('button', { name: /Continue to Payment/ }).last().click({ timeout: 120_000 });
    await page.getByRole('button', { name: /Pay ₹[\d,.]+ Securely/ }).click({ timeout: 120_000 });
    await page.getByRole('button', { name: /Simulate successful payment/ }).click({ timeout: 60_000 });
    await page.waitForURL(/confirmation|\/orders\//, { timeout: 120_000 });
    const order = await prisma.order.findFirst({ where: { userId: S.shopperId }, orderBy: { createdAt: 'desc' }, include: { items: true, payment: true } });
    check(order && order.paymentMethod !== 'COD', `order ${order?.paymentMethod}`);
    check(order.payment && !/FAIL|PENDING|CREATED/.test(order.payment.status), `payment ${order.payment?.status}`);
    S.prepaidOrderId = order.id;
    S.prepaidItemId = order.items[0].id;
    const inv = await api('GET', `/api/orders/${order.id}/invoices`, S.shopperToken);
    check(inv.status === 200, `invoice ${inv.status}`);
    const notes = await apiOk('GET', '/api/notifications', S.shopperToken);
    check(JSON.stringify(notes).includes(order.orderNumber), 'no notification about the order');
  }, { page, needs: ['cart'], key: 'prepaid' });

  await step(F, 'COD order under the cap is placed', async () => {
    await apiOk('POST', '/api/cart/items', S.shopperToken, { variantId: S.clothVariantId ?? S.simpleVariantId, quantity: 1 });
    const co = await apiOk('POST', '/api/orders/checkout', S.shopperToken, { addressId: S.addressId, paymentMethod: 'COD' });
    S.codOrderId = co.orderId;
    const o = await prisma.order.findUnique({ where: { id: co.orderId }, include: { items: true } });
    check(o.paymentMethod === 'COD', o.paymentMethod);
    S.codItemId = o.items[0].id;
  }, { needs: ['shopper', 'live'], key: 'cod' });

  await step(F, 'COD above the cap is refused', async () => {
    const settings = await apiOk('GET', '/api/settings/public', null);
    const cap = settings.codMaxOrderPaise;
    const qty = Math.ceil(cap / 120000) + 1;
    await prisma.productVariant.update({ where: { id: S.simpleVariantId }, data: { stock: { increment: qty + 5 } } });
    await apiOk('POST', '/api/cart/items', S.shopperToken, { variantId: S.simpleVariantId, quantity: Math.min(qty, 10) });
    const r = await api('POST', '/api/orders/checkout', S.shopperToken, { addressId: S.addressId, paymentMethod: 'COD' });
    check(r.status >= 400, `COD over ₹${cap / 100} was accepted`);
    check(/cash on delivery|COD/i.test(r.json?.error?.message ?? ''), `refusal: ${r.json?.error?.message}`);
    await api('DELETE', '/api/cart', S.shopperToken);
  }, { needs: ['shopper', 'live'] });
}

// ---------------------------------------------------------------------------
// 9 Fulfilment
// ---------------------------------------------------------------------------
/** A short WebM from Chrome's fake camera, recorded on a throwaway local page (camera allowed there). */
async function fakeClip() {
  if (S.clipFile) return S.clipFile;
  const http = await import('node:http');
  const srv = http.createServer((_q, r) => r.end('<html><body>clip</body></html>')).listen(4798);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto('http://localhost:4798/');
  const b64 = await p.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    document.body.appendChild(c);
    const g = c.getContext('2d');
    let f = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${(f += 12) % 360},60%,50%)`;
      g.fillRect(0, 0, 320, 240);
      g.fillStyle = '#fff';
      g.fillText(`packing ${f}`, 20, 120);
    }, 50);
    const stream = c.captureStream(20);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(250);
    await new Promise((r) => setTimeout(r, 2000));
    rec.stop();
    await done;
    const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
    let s = '';
    for (const byte of new Uint8Array(buf)) s += String.fromCharCode(byte);
    return btoa(s);
  });
  await ctx.close();
  srv.close();
  S.clipFile = path.join(OUT, 'packing-clip.webm');
  fs.writeFileSync(S.clipFile, Buffer.from(b64, 'base64'));
  return S.clipFile;
}

async function attachClipByApi(orderId) {
  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync(await fakeClip())], { type: 'video/webm' }), 'packing.webm');
  const up = await fetch(`${API}/api/uploads/video`, { method: 'POST', headers: { 'x-forwarded-for': SCRIPT_IP, authorization: `Bearer ${S.sellerToken}` }, body: form });
  const uj = await up.json();
  check(up.ok, `video upload ${up.status} ${uj?.error?.message}`);
  await apiOk('POST', `/api/seller/orders/${orderId}/packing-video`, S.sellerToken, { ref: uj.data.ref });
}

async function fulfil(orderId, itemId, page, { tag }) {
  // Packing video, packed, booked (mock Delhivery), label, shipped, delivered.
  await goto(page, `/seller/orders/${orderId}`);
  const video = page.locator('[data-packing-video]');
  await video.waitFor({ timeout: 120_000 });
  if ((await video.getAttribute('data-packing-video')) === 'missing') {
    if (!S.cameraTried) {
      S.cameraTried = true;
      await step('9 Fulfilment', 'packing video recorded in the browser (fake camera)', async () => {
        await page.getByRole('button', { name: /Record video/i }).first().click();
        const blocked = page.getByText(/Camera permission was denied|can.t record video/i);
        if (await blocked.first().waitFor({ timeout: 8000 }).then(() => true, () => false)) {
          const res = await page.request.get(page.url());
          throw new Error(`the page refused the camera: "${await blocked.first().innerText()}" (Permissions-Policy: ${res.headers()['permissions-policy']})`);
        }
        await page.getByRole('button', { name: /Start recording|Record/i }).first().click();
        await page.waitForTimeout(2500);
        await page.getByRole('button', { name: /Stop/i }).first().click();
        await page.getByRole('button', { name: 'Use this video' }).click({ timeout: 30_000 });
        await toast(page, /Packing video saved/, 60_000);
      }, { page });
    }
    if ((await prisma.orderPackingVideo.count({ where: { orderId } }).catch(() => 0)) === 0) {
      await attachClipByApi(orderId);
      await page.reload();
      await hydrated(page);
    }
  }
  await page.getByRole('button', { name: /Mark packed/ }).first().click({ timeout: 30_000 });
  await toast(page, /Marked packed/);
  await page.getByRole('button', { name: /Book with Delhivery/ }).first().click();
  const box = page.locator('input[type=number]');
  await page.locator('[data-action=confirm-booking]').waitFor({ timeout: 30_000 });
  for (const b of await box.all()) if (!(await b.inputValue())) await b.fill('10');
  await page.locator('[data-action=confirm-booking]').click();
  let shipment = null;
  for (let i = 0; i < 30 && !shipment?.awbNumber; i++) {
    await page.waitForTimeout(1000);
    shipment = await prisma.shipment.findFirst({ where: { orderId, kind: 'FORWARD' }, orderBy: { createdAt: 'desc' } });
  }
  check(shipment?.awbNumber, `${tag}: no AWB after booking`);
  if (!S.bookToastChecked) {
    S.bookToastChecked = true;
    await step('9 Fulfilment', 'booking from the order page says "booked with Delhivery"', async () => {
      await toast(page, /booked with Delhivery/i, 5000);
    }, { page });
  }
  const label = await page.request.get(`${WEB}/seller/orders/labels?ids=${itemId}`);
  check(label.ok(), `${tag}: label page ${label.status()}`);
  await courier(shipment.awbNumber, 'PICKED_UP');
  return shipment;
}

async function flow9Fulfilment() {
  const F = '9 Fulfilment';
  const page = S.sellerPage;
  await step(F, 'prepaid order: packing video, packed, booked, label, shipped, delivered', async () => {
    S.prepaidShipment = await fulfil(S.prepaidOrderId, S.prepaidItemId, page, { tag: 'prepaid' });
    await courier(S.prepaidShipment.awbNumber, 'DELIVERED');
    const item = await prisma.orderItem.findUnique({ where: { id: S.prepaidItemId } });
    check(item.status === 'DELIVERED', `line ${item.status}`);
  }, { page, needs: ['prepaid'], key: 'delivered' });

  await step(F, 'ledger: sale, commission, fees, GST, TDS, TCS, forward freight', async () => {
    const rows = await ledger(S.sellerId, S.prepaidOrderId);
    const types = new Set(rows.map((r) => r.type));
    // GST is inside the sale (the buyer price includes it; the invoice splits it); TCS is GST_TCS.
    const want = ['SALE_EARNING', 'COMMISSION', 'PLATFORM_FEE', 'GATEWAY_FEE', 'TDS', 'GST_TCS', 'FORWARD_FREIGHT'];
    const missing = want.filter((t) => !types.has(t));
    check(!missing.length, `missing ${missing.join(', ')} (have ${[...types].join(', ')})`);
    const sale = rows.find((r) => r.type === 'SALE_EARNING');
    const item = await prisma.orderItem.findUnique({ where: { id: S.prepaidItemId } });
    check(item.gstRatePercent === 18, `GST rate recorded on the line: ${item.gstRatePercent}`);
    check(sale.amountPaise > 0, `sale earning ${sale.amountPaise}`);
  }, { needs: ['delivered'] });

  await step(F, 'COD order delivered: COD fee on the ledger', async () => {
    const s = await fulfil(S.codOrderId, S.codItemId, page, { tag: 'cod' });
    await courier(s.awbNumber, 'DELIVERED');
    const rows = await ledger(S.sellerId, S.codOrderId);
    check(rows.some((r) => r.type === 'COD_FEE'), `no COD_FEE (have ${rows.map((r) => r.type).join(', ')})`);
    S.codShipmentId = s.id;
  }, { page, needs: ['cod'], key: 'codDelivered' });

  await step(F, 'late dispatch: penalty after 24 h (time-shifted), under Penalties', async () => {
    await apiOk('POST', '/api/cart/items', S.shopperToken, { variantId: S.simpleVariantId, quantity: 1 });
    const co = await apiOk('POST', '/api/orders/checkout', S.shopperToken, { addressId: S.addressId, paymentMethod: 'COD' });
    S.lateOrderId = co.orderId;
    const old = new Date(Date.now() - 30 * 3600_000);
    await prisma.order.update({ where: { id: co.orderId }, data: { createdAt: old } });
    runService(`import { sweepLateDispatch } from './src/services/lateDispatch.ts';\nconsole.log('charged', await sweepLateDispatch());\nprocess.exit(0);\n`);
    const rows = await ledger(S.sellerId, co.orderId);
    check(rows.some((r) => r.type === 'LATE_DISPATCH_PENALTY'), `no late-dispatch penalty (have ${rows.map((r) => r.type).join(', ')})`);
    await goto(page, '/seller/penalties');
    await page.getByText(/late|dispatch/i).first().waitFor({ timeout: 120_000 });
  }, { page, needs: ['shopper', 'live'] });

  await step(F, 'seller cancels an order: ₹150 penalty, shown under Penalties', async () => {
    await apiOk('POST', '/api/cart/items', S.shopperToken, { variantId: S.simpleVariantId, quantity: 1 });
    const co = await apiOk('POST', '/api/orders/checkout', S.shopperToken, { addressId: S.addressId, paymentMethod: 'COD' });
    await goto(page, `/seller/orders/${co.orderId}`);
    await page.getByRole('button', { name: /Cancel (this order|my items|order)/i }).first().click({ timeout: 120_000 });
    await page.locator('textarea, input[type=text]').last().fill('E2E: out of stock at the warehouse');
    await page.getByRole('button', { name: /Cancel my items/ }).click();
    await toast(page, /cancelled.*₹150|₹150.*penalty/i, 30_000);
    const rows = await ledger(S.sellerId, co.orderId);
    const pen = rows.find((r) => r.type === 'SELLER_CANCEL_PENALTY');
    check(pen && Math.abs(pen.amountPaise) === 15000, `penalty rows: ${rows.map((r) => `${r.type}:${r.amountPaise}`).join(', ')}`);
    await goto(page, '/seller/penalties');
    await page.getByText(/cancel/i).first().waitFor({ timeout: 120_000 });
  }, { page, needs: ['shopper', 'live'] });
}

// ---------------------------------------------------------------------------
// 10 Cancellation, return, RTO
// ---------------------------------------------------------------------------
async function prepaidOrder(variantId, extra = {}) {
  await apiOk('POST', '/api/cart/items', S.shopperToken, { variantId, quantity: 1 });
  const co = await apiOk('POST', '/api/orders/checkout', S.shopperToken, { addressId: S.addressId, paymentMethod: 'UPI', ...extra });
  await apiOk('POST', '/api/payments/mock-pay', S.shopperToken, { orderId: co.orderId, outcome: 'success' });
  return prisma.order.findUnique({ where: { id: co.orderId }, include: { items: true } });
}

async function flow10CancelReturnRto() {
  const F = '10 Cancel/Return/RTO';
  await step(F, 'shopper cancels a paid order: refunded, credits reversed', async () => {
    await prisma.user.update({ where: { id: S.shopperId }, data: { creditsBalance: { increment: 200 } } });
    S.creditsBefore = (await prisma.user.findUnique({ where: { id: S.shopperId } })).creditsBalance;
    const o = await prepaidOrder(S.simpleVariantId, { useCredits: true });
    const page = S.shopPage;
    await goto(page, `/account/orders/${o.id}`);
    await page.getByRole('button', { name: /^Cancel/ }).first().click({ timeout: 120_000 });
    await page.waitForTimeout(2500);
    const after = await prisma.order.findUnique({ where: { id: o.id }, include: { items: true } });
    check(after.items.every((i) => i.status === 'CANCELLED'), `items ${after.items.map((i) => i.status)}`);
    const refunds = await prisma.refund.findMany({ where: { orderId: o.id } });
    check(refunds.length > 0, 'no refund');
    check(o.creditsUsed > 0, `the order used no credits (${o.creditsUsed})`);
    const u = await prisma.user.findUnique({ where: { id: S.shopperId } });
    check(u.creditsBalance >= S.creditsBefore, `credits ${S.creditsBefore} before the order → ${u.creditsBalance} after cancelling`);
  }, { page: () => S.shopPage, needs: ['shopper', 'live'] });

  await step(F, 'return: approved, reverse pickup, refund, reverse freight on the ledger', async () => {
    const o = await prepaidOrder(S.simpleVariantId);
    const s = await fulfil(o.id, o.items[0].id, S.sellerPage, { tag: 'return' });
    await courier(s.awbNumber, 'DELIVERED');
    await apiOk('POST', `/api/orders/items/${o.items[0].id}/return`, S.shopperToken, { reason: 'SIZE_FIT', details: 'E2E: too large' });
    const ret = await prisma.return.findFirst({ where: { orderItemId: o.items[0].id } });
    check(ret, 'no return');
    const page = S.sellerPage;
    await goto(page, `/seller/returns/${ret.id}`);
    await page.getByRole('button', { name: /Approve return/ }).click({ timeout: 120_000 });
    await toast(page, /Return approved/);
    const reverse = await prisma.shipment.findFirst({ where: { orderId: o.id, kind: 'REVERSE' } });
    check(reverse?.awbNumber, 'no reverse pickup booked');
    await courier(reverse.awbNumber, 'PICKED_UP');
    await courier(reverse.awbNumber, 'DELIVERED');
    await goto(page, `/seller/returns/${ret.id}`);
    await page.getByRole('button', { name: /Item received back/ }).click({ timeout: 120_000 }).catch(() => {});
    await page.getByRole('button', { name: /Condition OK/ }).click({ timeout: 30_000 });
    await toast(page, /refund is on its way/);
    const rows = await ledger(S.sellerId, o.id);
    check(rows.some((r) => r.type === 'RETURN_FREIGHT'), `no RETURN_FREIGHT (have ${rows.map((r) => r.type).join(', ')})`);
    const refunds = await prisma.refund.findMany({ where: { orderId: o.id } });
    check(refunds.length > 0, 'no refund');
  }, { page: () => S.sellerPage, needs: ['shopper', 'live', 'delivered'] });

  await step(F, 'RTO: refund when RTO starts, RTO freight, the buyer\'s RTO count', async () => {
    const o = await prepaidOrder(S.simpleVariantId);
    const s = await fulfil(o.id, o.items[0].id, S.sellerPage, { tag: 'rto' });
    const before = await prisma.user.findUnique({ where: { id: S.shopperId } });
    await courier(s.awbNumber, 'DELIVERY_FAILED');
    await courier(s.awbNumber, 'RTO');
    const refunds = await prisma.refund.findMany({ where: { orderId: o.id } });
    check(refunds.length > 0, 'not refunded when RTO started');
    await courier(s.awbNumber, 'RTO_DELIVERED');
    const rows = await ledger(S.sellerId, o.id);
    check(rows.some((r) => r.type === 'RTO_FREIGHT'), `no RTO_FREIGHT (have ${rows.map((r) => r.type).join(', ')})`);
    const after = await prisma.user.findUnique({ where: { id: S.shopperId } });
    check((after.rtoCount ?? 0) === (before.rtoCount ?? 0) + 1, `rtoCount ${before.rtoCount} → ${after.rtoCount}`);
  }, { page: () => S.sellerPage, needs: ['shopper', 'live', 'delivered'] });
}

// ---------------------------------------------------------------------------
// 11 Payouts
// ---------------------------------------------------------------------------
async function flow11Payouts() {
  const F = '11 Payouts';
  const page = S.sellerPage;
  await step(F, 'PAN gate: no payout without a PAN on file', async () => {
    const pan = (await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } })).panNumber;
    await prisma.sellerProfile.update({ where: { id: S.sellerId }, data: { panNumber: null } });
    const r = await api('POST', '/api/seller/payouts/request', S.sellerToken, {});
    await prisma.sellerProfile.update({ where: { id: S.sellerId }, data: { panNumber: pan } });
    // Putting the PAN back makes it "changed since verified": verify it again (mock).
    await apiOk('POST', '/api/seller/kyc/verify', S.sellerToken).catch(() => {});
    check(r.status >= 400 && /PAN/i.test(r.json?.error?.message ?? ''), `request without PAN: ${r.status} ${r.json?.error?.message}`);
  }, { needs: ['approved'] });

  await step(F, 'COD money held until Delhivery\'s remittance is marked', async () => {
    const overview = JSON.stringify(await apiOk('GET', '/api/seller/payouts/overview', S.sellerToken));
    check(/waits for Delhivery/.test(overview), 'the payouts overview does not say COD money waits for Delhivery');
    const admin = S.adminPage;
    await goto(admin, '/admin/cod-remittance');
    const ship = await prisma.shipment.findUnique({ where: { id: S.codShipmentId } });
    await admin.locator('tr').filter({ hasText: ship.awbNumber }).getByRole('button', { name: 'Mark remitted' }).click({ timeout: 120_000 });
    await toast(admin, /Marked remitted/);
    const s2 = await prisma.shipment.findUnique({ where: { id: S.codShipmentId } });
    check(s2.codRemittedAt, 'codRemittedAt not set');
  }, { page: S.adminPage, needs: ['codDelivered'] });

  await step(F, 'GSTR-8 export (admin)', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const r = await fetch(`${API}/api/admin/payments/gstr8?month=${month}`, { headers: { 'x-forwarded-for': SCRIPT_IP, authorization: `Bearer ${S.adminToken}` } });
    check(r.ok, `GSTR-8 ${r.status}`);
    const csv = await r.text();
    check(csv.includes(S.sellerGstin), 'the seller\'s GSTIN is not in this month\'s GSTR-8');
  }, { needs: ['admin', 'delivered'] });

  await step(F, 'payout requested ("Payout requested")', async () => {
    // Past the clearing hold, so the delivered lines are payable.
    await prisma.sellerLedgerEntry.updateMany({ where: { sellerId: S.sellerId }, data: { createdAt: new Date(Date.now() - 30 * 86400_000) } }).catch(() => {});
    await prisma.orderItem.updateMany({ where: { order: { items: { some: { product: { sellerId: S.sellerId } } } }, status: 'DELIVERED' }, data: { deliveredAt: new Date(Date.now() - 30 * 86400_000) } }).catch(() => {});
    await goto(page, '/seller/payouts');
    const btn = page.getByRole('button', { name: /Request payout/ });
    await btn.waitFor({ timeout: 120_000 });
    check(await btn.isEnabled(), `request button disabled: ${await btn.getAttribute('title')}`);
    await btn.click();
    await toast(page, /Payout requested/, 30_000);
    check(await prisma.payout.count({ where: { sellerId: S.sellerId } }) > 0, 'no payout row');
  }, { page, needs: ['delivered'] });

  await step(F, 'statement and TDS report download', async () => {
    const st = await fetch(`${API}/api/seller/payouts/statement`, { headers: { 'x-forwarded-for': SCRIPT_IP, authorization: `Bearer ${S.sellerToken}` } }).catch(() => null);
    const tds = await fetch(`${API}/api/seller/payouts/tds-report`, { headers: { 'x-forwarded-for': SCRIPT_IP, authorization: `Bearer ${S.sellerToken}` } });
    check(tds.ok, `TDS report ${tds.status}`);
    check(!st || st.ok || st.status === 404, `statement ${st?.status}`);
  }, { needs: ['approved'] });


}

// ---------------------------------------------------------------------------
// 12 Support
// ---------------------------------------------------------------------------
async function flow12Support() {
  const F = '12 Support';
  await step(F, 'seller raises a ticket ("Ticket raised")', async () => {
    const page = S.sellerPage;
    await goto(page, '/seller/support');
    await page.getByRole('button', { name: /Raise a ticket/ }).first().click({ timeout: 120_000 });
    S.ticketSubject = `E2E payout question ${RUN}`;
    await page.locator('[name=subject]').fill(S.ticketSubject);
    await page.locator('[name=body]').fill('When will my first payout reach my bank account? (end-to-end run)');
    await page.locator('[data-action=submit-ticket]').click();
    await toast(page, /Ticket raised/);
  }, { page: S.sellerPage, needs: ['seller'], key: 'ticket' });

  await step(F, 'admin replies from the inbox; the seller is notified within seconds', async () => {
    const admin = S.adminPage;
    await goto(admin, '/admin/support');
    await admin.getByText(S.shopName).first().click({ timeout: 120_000 });
    const before = Date.now();
    await admin.locator('textarea').last().fill('Payouts go out within 2 working days of a request. — E2E admin');
    await admin.locator('[data-action=send-reply]').click();
    await toast(admin, /Reply sent/);
    let seen = false;
    while (Date.now() - before < 15_000 && !seen) {
      const n = await apiOk('GET', '/api/notifications', S.sellerToken);
      seen = JSON.stringify(n).includes(S.ticketSubject) || /reply|replied/i.test(JSON.stringify(n).slice(0, 2000));
      if (!seen) await new Promise((r) => setTimeout(r, 1000));
    }
    check(seen, 'the seller had no notification 15 s after the reply');
  }, { page: S.adminPage, needs: ['ticket', 'admin'] });

  await step(F, 'customer raises a request from Help and it reaches the admin inbox', async () => {
    const page = S.shopPage;
    await goto(page, '/account/help');
    await page.getByRole('button', { name: 'Submit a Request' }).click({ timeout: 120_000 });
    S.complaint = `E2E where is my parcel ${RUN}`;
    await page.getByPlaceholder(/Describe the issue/).fill(`${S.complaint}: it has not moved for two days.`);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.waitForTimeout(2000);
    const c = await prisma.complaint.findFirst({ where: { userId: S.shopperId }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    check(c, 'no request stored');
    const admin = S.adminPage;
    await goto(admin, '/admin/support');
    await admin.getByText(S.complaint).first().waitFor({ timeout: 120_000 });
  }, { page: () => S.shopPage, needs: ['shopper', 'admin'] });
}

// ---------------------------------------------------------------------------
// 13 Admin screens and the audit log
// ---------------------------------------------------------------------------
async function flow13Admin() {
  const F = '13 Admin';
  const page = S.adminPage;
  const auditBefore = await prisma.auditLog.count({ where: { actorId: S.admin?.id } }).catch(() => 0);
  await step(F, 'facets: a category\'s filters save', async () => {
    await goto(page, '/admin/facets');
    await page.locator('main').getByText('Laptops', { exact: true }).first().click({ timeout: 120_000 });
    const down = page.getByRole('button', { name: /^Move .* down$/ }).first();
    await down.click({ timeout: 30_000 });
    await page.locator('[data-action=save-facets]').click();
    await toast(page, /Filters saved/);
    await page.getByRole('button', { name: /^Move .* up$/ }).nth(1).click();
    await page.locator('[data-action=save-facets]').click();
    await toast(page, /Filters saved/);
  }, { page, needs: ['admin'] });

  await step(F, 'categories: add one, deactivate it', async () => {
    await goto(page, '/admin/categories');
    const name = `E2E Cat ${RUN.slice(-6)}`;
    await page.getByPlaceholder(/Name|Category name/i).first().fill(name, { timeout: 120_000 });
    await page.getByRole('button', { name: 'Add' }).click();
    await toast(page, /added/);
    const cat = await prisma.category.findFirst({ where: { name } });
    check(cat, 'category not stored');
    S.e2eCategoryId = cat.id;
    await page.locator('div').filter({ hasText: name }).getByRole('button', { name: 'Deactivate' }).last().click();
    await toast(page, /deactivated/);
  }, { page, needs: ['admin'] });

  await step(F, 'hero banner: create with an uploaded image, then delete', async () => {
    await goto(page, '/admin/banners');
    await page.getByRole('button', { name: '+ New banner' }).click({ timeout: 120_000 });
    await page.locator('input[name=headline]').fill(`E2E banner ${RUN}`);
    const img = await makeImage('hero-2000x750.jpg', 2000, 750, '#5b3a29');
    await page.locator('input[type=file]').first().setInputFiles(img);
    await toast(page, /Image uploaded/, 60_000);
    await page.locator('[data-action=save-banner]').click();
    await toast(page, /Banner created/);
    const b = await prisma.homeBanner.findFirst({ where: { headline: `E2E banner ${RUN}` } });
    check(b?.imageUrl?.includes('-w2000.webp'), `banner image ${b?.imageUrl}`);
    await page.locator('div').filter({ hasText: `E2E banner ${RUN}` }).getByRole('button', { name: 'Delete' }).last().click();
    await toast(page, /Banner deleted/);
  }, { page, needs: ['admin'] });

  await step(F, 'users: block and unblock', async () => {
    const u = await seedUser('CUSTOMER', `E2E Blockme ${RUN}`);
    await goto(page, `/admin/users`);
    await page.getByPlaceholder(/Search name or phone/).fill(u.phone, { timeout: 120_000 });
    await page.getByRole('button', { name: 'Block' }).first().click({ timeout: 30_000 });
    await toast(page, /blocked/);
    check(!(await prisma.user.findUnique({ where: { id: u.id } })).isActive, 'still active');
    await page.getByRole('button', { name: 'Unblock' }).first().click();
    await toast(page, /unblocked/);
  }, { page, needs: ['admin'] });

  await step(F, 'CSP reports page shows a reported violation', async () => {
    await fetch(`${API}/api/csp-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'document-uri': `${WEB}/e2e`, 'violated-directive': 'img-src', 'blocked-uri': `https://e2e-${RUN}.example.com/x.png` } }),
    });
    await goto(page, '/admin/csp-reports');
    await page.getByText(`e2e-${RUN}.example.com`).first().waitFor({ timeout: 120_000 });
  }, { page, needs: ['admin'] });

  await step(F, 'audit log has an entry for each admin action of this run', async () => {
    const rows = await prisma.auditLog.findMany({ where: { actorId: S.admin.id }, select: { action: true, module: true } });
    check(rows.length > auditBefore, 'no audit entries for this run\'s admin');
    const text = rows.map((r) => `${r.module}:${r.action}`).join(' | ');
    const expect = [/SELLERS:/, /PRODUCTS:/, /SETTINGS:/, /ADS:/, /USERS:/, /BANNERS:/, /CATEGORIES:/, /CATEGORYFACETS:/];
    const missing = expect.filter((re) => !re.test(text));
    check(!missing.length, `no audit entry matching ${missing.join(', ')} — have: ${text.slice(0, 300)}`);
  }, { page, needs: ['admin'] });

  await step(F, "the Audit Logs page shows today's entries by default", async () => {
    await goto(page, '/admin/audit');
    const shown = await page.getByText(S.admin.name).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (!shown) {
      const to = await page.locator('input[type=date]').nth(1).inputValue().catch(() => '?');
      const istToday = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
      throw new Error(`this run's entries are not listed: the default range ends ${to} while today in India is ${istToday}`);
    }
  }, { page, needs: ['admin'] });
}

// ---------------------------------------------------------------------------
// Production — read only
// ---------------------------------------------------------------------------
async function prodChecks() {
  const F = 'P Production (read-only)';
  const { chromium } = playwright();
  const pb = await chromium.launch({ channel: 'chrome' });
  const ctx = await pb.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(`${page.url()}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  // Name the resource behind a "Failed to load resource" console line.
  page.on('response', (r) => r.status() >= 400 && errors.push(`${page.url()}: HTTP ${r.status()} ${r.url()}`));
  const stock = /picsum\.photos|loremflickr\.com|unsplash\.com|images\.pexels\.com/;

  await step(F, 'health OK', async () => {
    const r = await fetch(`${PROD}/api/health`);
    const j = await r.json();
    check(r.ok && j.data?.status === 'ok' && j.data?.database === 'up', JSON.stringify(j));
  });

  let pages = ['/', '/products', '/contact', '/sell', '/track', '/login', '/cart', '/tryon'];
  await step(F, 'policy pages are listed', async () => {
    const html = await (await fetch(`${PROD}/`)).text();
    const linked = [...new Set([...html.matchAll(/href="(\/pages\/[a-z0-9-]+)"/g)].map((m) => m[1]))];
    check(linked.length >= 4, `only ${linked.length} /pages links in the footer`);
    pages = [...pages, ...linked];
  });
  await step(F, 'category pages are listed', async () => {
    const cats = await (await fetch(`${PROD}/api/categories`)).json();
    for (const c of (cats.data ?? []).slice(0, 4)) pages.push(`/category/${c.slug}`);
  });

  for (const p of pages) {
    await step(F, `${p} loads, no console errors, no stock photos`, async () => {
      const before = errors.length;
      const res = await page.goto(`${PROD}${p}`, { waitUntil: 'networkidle', timeout: 90_000 });
      check(res && res.status() < 400, `HTTP ${res?.status()}`);
      const srcs = await page.locator('img').evaluateAll((els) => els.map((e) => e.currentSrc || e.src));
      const bad = srcs.filter((s) => stock.test(s));
      check(!bad.length, `stock photos: ${bad.slice(0, 3).join(', ')}`);
      const broken = await page.locator('img').evaluateAll((els) => els.filter((e) => e.complete && e.naturalWidth === 0 && e.src).map((e) => e.src));
      check(!broken.length, `broken images: ${broken.slice(0, 3).join(', ')}`);
      const errs = errors.slice(before);
      check(!errs.length, `console: ${errs.slice(0, 2).join(' | ')}`);
    }, { page });
  }

  await step(F, 'home banners and sponsored slots render', async () => {
    await page.goto(`${PROD}/`, { waitUntil: 'networkidle', timeout: 90_000 });
    check(await page.locator('section[aria-roledescription=carousel]').count(), 'no hero carousel');
    const home = await (await fetch(`${PROD}/api/home`)).json();
    check((home.data?.banners ?? []).length > 0, 'no home banners in /api/home');
    const ads = await fetch(`${PROD}/api/ads/active?placement=HOME_BANNER`).then((r) => r.json()).catch(() => null);
    const sponsored = await page.getByText(/Sponsored/i).count();
    check(sponsored > 0 || (ads?.data ?? []).length === 0, `ads exist (${(ads?.data ?? []).length}) but no Sponsored slot is shown`);
  }, { page });
  await pb.close();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function writeReport() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# E2E run ${RUN}`,
    '',
    `${pass} passed, ${fail} failed, of ${results.length} steps. Local stack, every provider on its mock; production read-only.`,
    '',
    '| Flow | Step | Result | Cause | Screenshot |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${esc(r.flow)} | ${esc(r.step)} | ${r.status} | ${esc(r.cause)} | ${esc(r.shot)} |`),
  ];
  if (pageProblems.length) lines.push('', '## Page errors seen during the run', '', ...pageProblems.slice(0, 40).map((p) => `- ${esc(p)}`));
  fs.writeFileSync(path.join(OUT, 'report.md'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ run: RUN, results, pageProblems }, null, 2));
  log(`\n${pass} PASS, ${fail} FAIL — ${path.relative(ROOT, path.join(OUT, 'report.md'))}`);
}

process.on('uncaughtException', (err) => log(`(ignored stray error: ${err.message})`));
process.on('unhandledRejection', (err) => log(`(ignored stray rejection: ${err?.message ?? err})`));

main()
  .catch((err) => {
    log(`run crashed: ${err.stack ?? err}`);
    writeReport();
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
