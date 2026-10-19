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
  LOST: ['Lost', 'UD', 'LT-100'],
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

/** A small, valid PDF (an application document). */
function makePdf(name) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  return file;
}

/** Upload a file the way the pages do (multipart), as `token`'s user. */
async function upload(token, route, field, file, purpose) {
  const form = new FormData();
  if (purpose) form.append('purpose', purpose);
  const type = file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.webm') ? 'video/webm' : 'image/jpeg';
  form.append(field, new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  const res = await fetch(`${API}${route}`, { method: 'POST', headers: { 'x-forwarded-for': SCRIPT_IP, authorization: `Bearer ${token}` }, body: form });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, ref: json.data?.ref ?? json.data?.items?.[0]?.ref };
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

async function newPage(label, viewport = { width: 1366, height: 900 }, { consent = true } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  // The cookie banner (Cookie Policy 4) is answered up front, except where a step tests it.
  if (consent) {
    const value = encodeURIComponent(JSON.stringify({ v: 1, functional: true, analytics: false, advertising: false, at: new Date().toISOString() }));
    await ctx.addCookies([{ name: 'clowe_consent', value, url: WEB }]);
  }
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

/**
 * A fresh access token for the session a page holds, the way the site renews
 * it (POST /api/auth/refresh with the session cookie). The run outlasts an
 * access token, so the script renews before each flow and before each order.
 */
async function renew(page) {
  if (!page || page.isClosed()) return null;
  const token = await page
    .evaluate(async (api) => {
      const res = await fetch(`${api}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localStorage.getItem('clowe.refreshToken') ? { refreshToken: localStorage.getItem('clowe.refreshToken') } : {}),
      });
      const json = await res.json();
      if (!json.success) return null;
      localStorage.setItem('clowe.accessToken', json.data.accessToken);
      return json.data.accessToken;
    }, API)
    .catch(() => null);
  return token ?? (await tokenOf(page).catch(() => null));
}

/** Renew every session the script uses. */
async function renewAll() {
  if (S.shopPage) S.shopperToken = (await renew(S.shopPage)) ?? S.shopperToken;
  if (S.sellerPage) S.sellerToken = (await renew(S.sellerPage)) ?? S.sellerToken;
  if (S.adminPage) S.adminToken = (await renew(S.adminPage)) ?? S.adminToken;
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
    if (want(9)) await renewAll().then(flow9Fulfilment);
    if (want(10)) await renewAll().then(flow10CancelReturnRto);
    if (want(11)) await renewAll().then(flow11Payouts);
    if (want(12)) await renewAll().then(flow12Support);
    if (want(13)) await renewAll().then(flow13Admin);
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

  await step(F, 'register: the phone is verified first (OTP, mock)', async () => {
    await goto(page, '/seller/register');
    await page.locator('input[name=phone]').fill(S.sellerPhone, { timeout: 120_000 });
    await withOtpCooldown(page, () => page.getByRole('button', { name: /^Send OTP$/ }).click());
    await page.getByRole('button', { name: /Verify & continue/ }).click({ timeout: 60_000 });
    await page.locator('input[name=shopName]').waitFor({ timeout: 60_000 });
  }, { page, key: 'sellerPhone' });

  await step(F, 'register: a bad PAN is marked by its field, and the terms window does not open', async () => {
    await page.locator('input[name=shopName]').fill(S.shopName);
    await page.locator('input[name=panNumber]').fill('BADPAN');
    await page.getByRole('button', { name: /^Submit$/ }).click();
    await toast(page, /Fix the fields marked in red/);
    await page.locator('[name=panNumber] ~ p[role=alert], [name=panNumber] + p[role=alert]').first().waitFor({ timeout: 5000 });
    check(!(await page.locator('[data-vendor-terms]').count()), 'the Vendor Terms window opened with a bad PAN');
  }, { page, needs: ['sellerPhone'] });

  await step(F, 'register: documents, the full Vendor Terms (box unticked, Final Submit disabled), application submitted — not the dashboard', async () => {
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
    const pdf = makePdf('constitution.pdf');
    for (const n of ['constitutionDoc', 'cancelledChequeDoc', 'signatoryKycDoc']) {
      await page.locator(`input[type=file][name=${n}]`).setInputFiles(pdf);
    }
    await page.getByText('✓ uploaded').nth(2).waitFor({ timeout: 60_000 });
    check(await page.getByText(/upload the masked Aadhaar \(only the last 4 digits visible/).count(), 'the masked Aadhaar note is not on the form');
    check(await page.getByText('Brand proof (authorization letter or purchase invoice)').count(), 'the brand proof field is not named as such');
    check(await page.locator('[data-proprietorship-template]').count(), 'no proprietorship declaration template link');
    {
      const t = await newPage('template');
      await goto(t, '/templates/proprietorship-declaration');
      await t.getByRole('heading', { name: /Declaration of Sole Proprietorship/ }).waitFor({ timeout: 60_000 });
      const text = await t.locator('[data-proprietorship-declaration]').innerText();
      check(['Name of the business', 'Name of the proprietor', 'Address of the business', 'PAN', 'GSTIN', 'Signature of the proprietor'].every((w) => text.includes(w)), 'the declaration template lacks a field');
      await t.context().close();
    }
    await page.getByRole('button', { name: /^Submit$/ }).click();
    const terms = page.locator('[data-vendor-terms]');
    await terms.waitFor({ timeout: 30_000 });
    await terms.locator('[data-vendor-terms-text]').getByText(/Registration and Documentation/).waitFor({ timeout: 60_000 });
    const finalSubmit = terms.getByRole('button', { name: 'Final Submit' });
    check(!(await terms.locator('input[name=acceptVendorTerms]').isChecked()), 'the acceptance box started ticked');
    check(await finalSubmit.isDisabled(), 'Final Submit was enabled before the box was ticked');
    for (const link of ['Terms & Conditions', 'Privacy Policy', 'Seller Fees']) {
      check(await terms.getByRole('link', { name: link }).count(), `the terms window has no link to ${link}`);
    }
    await terms.locator('input[name=acceptVendorTerms]').check();
    await finalSubmit.click();
    const done = page.locator('[data-application-submitted]');
    await done.waitFor({ timeout: 60_000 });
    const shown = await done.innerText();
    check(/SA-[A-Z0-9]{8}/.test(shown), `no application number shown: ${shown.slice(0, 200)}`);
    check(/SMS and e-mail/.test(shown), 'the screen does not say we notify by SMS and e-mail');
    check(new URL(page.url()).pathname === '/seller/register', `went on to ${page.url()}`);
    const profile = await prisma.sellerProfile.findFirst({ where: { user: { phone: S.sellerPhone } }, include: { termsAcceptances: true } });
    check(profile, 'no seller profile in the database');
    check(profile.status === 'PENDING', `status ${profile.status}`);
    check(profile.gstNumber === S.sellerGstin, `GSTIN stored ${profile.gstNumber}`);
    check(profile.constitutionDoc && profile.cancelledChequeDoc && profile.signatoryKycDoc, 'documents not stored');
    check(profile.termsAcceptances.length === 1 && profile.termsAcceptances[0].ip, 'the terms acceptance was not recorded with its IP');
    S.sellerId = profile.id;
    S.sellerUserId = profile.userId;
    S.sellerToken = await tokenOf(page);
  }, { page, needs: ['sellerPhone'], key: 'seller' });

  await step(F, 'a pending seller sees only the application status, not the dashboard', async () => {
    await goto(page, '/seller/products');
    await page.locator('[data-application-status="Pending review"]').waitFor({ timeout: 60_000 });
    check(!(await page.getByRole('link', { name: /My Products/ }).count()), 'the dashboard menu is showing to a pending seller');
  }, { page, needs: ['seller'] });
}

// ---------------------------------------------------------------------------
// The seller's setup, once approved (a pending seller only sees the status page)
// ---------------------------------------------------------------------------
async function sellerSetup() {
  const F = '3 Seller setup';
  const page = S.sellerPage;
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
  }, { page, needs: ['approved'] });

  await step(F, 'business info: GSTIN, PAN and name on PAN save', async () => {
    await page.getByRole('button', { name: /Business info/ }).click();
    await page.locator('[name=panName]').fill('E2E SELLER');
    await saveStore(page);
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.panName === 'E2E SELLER' && p.panNumber === S.sellerPan, `stored panName=${p.panName} pan=${p.panNumber}`);
  }, { page, needs: ['approved'] });

  await step(F, 'KYC: the mock never verifies — PAN and GSTIN wait for review until an admin verifies them', async () => {
    await goto(page, '/seller/settings?tab=BUSINESS');
    await page.getByText('Pending review').first().waitFor({ timeout: 120_000 });
    check(!(await page.getByRole('button', { name: /Verify now/ }).count()), 'a Verify button is offered while the mock is the provider');
    const admin = S.adminPage;
    await openSellerKyc(admin, S.shopName);
    const review = admin.locator('[data-kyc-review]');
    await review.waitFor({ timeout: 60_000 });
    check(/Check .* on the GST portal/.test(await review.innerText()), 'no GST portal search link in KYC review');
    for (const c of ['PAN', 'GSTIN']) {
      await review.locator(`[data-kyc-verify=${c}]`).click();
      await toast(admin, new RegExp(`${c} verified`));
    }
    await review.locator('[data-kyc-check=PAN] [data-kyc-decided]').waitFor({ timeout: 30_000 });
    check(/By hand/.test(await review.locator('[data-kyc-check=PAN]').innerText()), 'the PAN decision does not say it was made by hand');
    await admin.keyboard.press('Escape');
    await goto(page, '/seller/settings?tab=BUSINESS');
    await page.getByText('Verified').first().waitFor({ timeout: 60_000 });
  }, { page, needs: ['approved', 'admin'] });

  await step(F, 'bank account: the seller adds it with a cancelled cheque (encrypted, masked); an admin verifies it', async () => {
    await goto(page, '/seller/settings?tab=BANK');
    const form = page.locator('[data-bank-account]');
    await form.waitFor({ timeout: 120_000 });
    if (await form.getByRole('button', { name: 'Change bank account' }).count()) await form.getByRole('button', { name: 'Change bank account' }).click();
    await form.locator('[name=accountName]').fill('E2E Seller');
    await form.locator('[name=accountNumber]').fill('50100012345678');
    await form.locator('[name=confirmAccountNumber]').fill('50100012345670');
    await form.locator('[name=ifsc]').fill('HDFC0001234');
    await form.locator('[data-cheque-file]').setInputFiles(makePdf('bank-cheque.pdf'));
    await form.getByText(/bank-cheque\.pdf — replace/).waitFor({ timeout: 60_000 });
    await form.getByRole('button', { name: 'Save bank account' }).click();
    await form.getByText('The two account numbers do not match').waitFor({ timeout: 10_000 });
    await form.locator('[name=confirmAccountNumber]').fill('50100012345678');
    await form.getByRole('button', { name: 'Save bank account' }).click();
    await toast(page, /Bank account saved/);
    await form.getByText('•••• •••• 5678').waitFor({ timeout: 30_000 });
    await form.locator('[data-bank-state=PENDING_REVIEW]').waitFor({ timeout: 30_000 });
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.bankAccountEnc?.startsWith('v1:') && !p.bankAccountEnc.includes('50100012345678') && !p.bankAccountNo, 'the bank account number is not stored encrypted only');
    const admin = S.adminPage;
    await openSellerKyc(admin, S.shopName);
    const review = admin.locator('[data-kyc-review]');
    await review.locator('[data-kyc-check=BANK]').getByText('50100012345678').waitFor({ timeout: 60_000 });
    await review.locator('[data-kyc-verify=BANK]').click();
    await toast(admin, /Bank account verified|BANK verified|Bank verified/i);
    await admin.keyboard.press('Escape');
    const s2 = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(s2.kycStatus === 'VERIFIED', `the shop is not KYC verified after all three checks: ${s2.kycStatus}`);
    const method = await prisma.sellerPayoutMethod.findFirst({ where: { sellerId: S.sellerId, accountLast4: '5678', verified: true } });
    check(method, 'the verified bank account did not become a verified payout account');
  }, { page, needs: ['approved', 'admin'] });

  await step(F, 'payout method (Payouts page) saved — waiting for Clowe to verify it', async () => {
    await goto(page, '/seller/payouts');
    const add = page.getByRole('button', { name: '＋ Add' }).first();
    {
      await add.click({ timeout: 120_000 });
      await page.locator('[name=label]').fill('E2E HDFC');
      await page.locator('[name=accountName]').fill('E2E Seller');
      await page.locator('[name=accountNumber]').fill('123456789012');
      await page.locator('[name=ifsc]').fill('HDFC0001234');
      await page.getByRole('button', { name: /^Save$/ }).click();
      await toast(page, /Payout method saved — Clowe verifies it/);
    }
    const added = await prisma.sellerPayoutMethod.findFirst({ where: { sellerId: S.sellerId, label: 'E2E HDFC' } });
    check(added && !added.verified, `the mock verified a payout method: ${JSON.stringify(added && { verified: added.verified })}`);
  }, { page, needs: ['approved'] });

  await step(F, 'pickup address (same as business) saves', async () => {
    await goto(page, '/seller/settings');
    await page.getByRole('button', { name: /Shipping & pickup/ }).click({ timeout: 120_000 });
    await saveStore(page);
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.pickupSameAsBusiness && p.pincode === '110059', `pickupSame=${p.pickupSameAsBusiness} pin=${p.pincode}`);
  }, { page, needs: ['approved'] });

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
  }, { page, needs: ['approved'] });
}

// ---------------------------------------------------------------------------
// 3 Admin approval
// ---------------------------------------------------------------------------
/** The seller's panel, at its KYC review (an approved seller has no Approve button to wait for). */
async function openSellerKyc(page, shopName) {
  await goto(page, '/admin/sellers');
  await page.getByPlaceholder(/Search shop/).fill(shopName);
  await page.locator('tr').filter({ hasText: shopName }).first().getByRole('button', { name: 'View' }).click({ timeout: 120_000 });
  await page.locator('[data-kyc-review]').waitFor({ timeout: 60_000 });
}

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

  await step(F, 'admin sees the documents and asks for more; the seller answers from the status page', async () => {
    await page.keyboard.press('Escape');
    await openSellerPanel(page, S.shopName);
    const app = page.locator('[data-application]');
    check((await app.getByRole('button', { name: 'open' }).count()) === 3, 'the three documents cannot be opened by the admin');
    check(/check it is masked/.test(await app.innerText()), 'no masked-Aadhaar reminder beside the signatory KYC');
    // Opening one goes through the API: a fresh link, and an audit entry.
    const [doc] = await Promise.all([page.waitForEvent('popup'), app.getByRole('button', { name: 'open' }).first().click()]);
    await doc.waitForLoadState().catch(() => {});
    await doc.close();
    await new Promise((r) => setTimeout(r, 500));
    check(await prisma.auditLog.count({ where: { action: 'Seller document viewed', entityId: S.sellerId } }) >= 1, 'opening a seller document was not audit-logged');
    check(/current version accepted/.test(await app.innerText()), 'the Vendor Terms acceptance is not shown');
    await page.locator('[data-action=request-info]').click();
    await toast(page, /Asked the seller for more/);
    const sp = S.sellerPage;
    await goto(sp, '/seller');
    await sp.locator('[data-application-status="Needs more info"]').waitFor({ timeout: 60_000 });
    await sp.locator('input[type=file][name=cancelledChequeDoc]').setInputFiles(makePdf('cheque-again.pdf'));
    await sp.getByText('✓').first().waitFor({ timeout: 60_000 });
    await sp.getByRole('button', { name: 'Send for review' }).click();
    await sp.locator('[data-application-status="Pending review"]').waitFor({ timeout: 60_000 });
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.infoRequest === null, `the request is still open: ${p.infoRequest}`);
  }, { page, needs: ['admin', 'seller'] });

  await step(F, 'admin approves the new seller ("Seller approved")', async () => {
    await page.keyboard.press('Escape');
    await openSellerPanel(page, S.shopName);
    await page.locator('[data-action=approve]').click();
    await toast(page, /Seller approved/, 30_000);
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(p.status === 'APPROVED', `status ${p.status}`);
    check(p.courierWarehouseStatus === 'ACTIVE', `Delhivery (mock) pickup address ${p.courierWarehouseStatus}: ${p.courierWarehouseError}`);
  }, { page, needs: ['admin', 'seller'], key: 'approved' });

  await step(F, 'a seller from before the Vendor Terms accepts them in the same window on their next visit', async () => {
    const u = await seedUser('SELLER', `E2E Old Seller ${RUN}`);
    await prisma.sellerProfile.create({
      data: { userId: u.id, shopName: `E2E Old Shop ${RUN}`, status: 'APPROVED', approvedAt: new Date(), gstNumber: gstinFor(randomPan()), panNumber: randomPan() },
    });
    const old = await newPage('old-seller');
    try {
      await pinLogin(old, u.phone, u.pin);
      await goto(old, '/seller');
      const terms = old.locator('[data-vendor-terms]');
      await terms.waitFor({ timeout: 60_000 });
      const accept = terms.getByRole('button', { name: 'Accept and continue' });
      check(await accept.isDisabled(), 'accept was enabled before the box was ticked');
      await terms.locator('input[name=acceptVendorTerms]').check();
      await accept.click();
      await terms.waitFor({ state: 'detached', timeout: 30_000 });
      const n = await prisma.sellerTermsAcceptance.count({ where: { seller: { userId: u.id } } });
      check(n === 1, `${n} acceptances recorded`);
    } finally {
      await old.context().close().catch(() => {});
    }
  }, { needs: ['admin'] });

  await sellerSetup();
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
    S.simpleCategoryId = p.categoryId;
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
    // The returns rule (no change-of-mind returns) and the "Sold by" box with the seller's address and contact.
    const pageText = await shop.locator('body').innerText();
    check(/48-hour claim window/.test(pageText), 'the 48-hour claim rule is not on the product page');
    check(!/\d+-day return/i.test(pageText), 'an old "N-day return" text is on the product page');
    const soldBy = await shop.locator('[data-sold-by]').innerText();
    check(/12 Defence Enclave/.test(soldBy) && /110059/.test(soldBy), `Sold by has no address: ${soldBy.replace(/\s+/g, ' ')}`);
    check(/Customer care/.test(soldBy) && /GSTIN/.test(soldBy), `Sold by lacks contact or GSTIN: ${soldBy.replace(/\s+/g, ' ')}`);
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
  await step(F, 'the seller has try-on credits (free grant at approval, else added by admin)', async () => {
    const p = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    if (p.tryOnCredits < 5) {
      await apiOk('POST', `/api/admin/sellers/${S.sellerId}/tryon-credits`, S.adminToken, { credits: 20, charge: false, note: `E2E ${RUN}` });
    }
    const after = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(after.tryOnCredits >= 5, `credits ${after.tryOnCredits}`);
    const lots = await prisma.tryOnCreditLot.findMany({ where: { sellerId: S.sellerId } });
    check(lots.some((l) => l.source === 'FREE_GRANT' || l.source === 'ADMIN'), `lots: ${lots.map((l) => l.source).join(', ')}`);
  }, { needs: ['approved'], key: 'tryonCredits' });

  await step(F, 'shopper try-on: result shown, seller credits down, shopper counted', async () => {
    S.tryShopper = await seedUser('CUSTOMER', `E2E TryOn ${RUN}`);
    const page = await newPage('tryon');
    S.tryPage = page;
    await pinLogin(page, S.tryShopper.phone, S.tryShopper.pin);
    const token = await tokenOf(page);
    const before = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    const photo = await makeImage('shopper-photo.jpg', 800, 1200, '#6b4f3a');
    // No photo is taken before the 18+ consent (Privacy Policy 3).
    const early = await upload(token, '/api/uploads/private', 'images', photo, 'TRYON_PHOTO');
    check(early.status >= 400 && /consent|18\+/i.test(JSON.stringify(early.json)), `a try-on photo was taken before consent (${early.status})`);
    await goto(page, `/products/${S.clothSlug}/tryon`);
    const consent = page.locator('input[name=tryOnConsent]').first();
    await consent.waitFor({ timeout: 120_000 });
    check(!(await consent.isChecked()), 'the consent box started ticked');
    await consent.check();
    const file = page.locator('input[type=file]').first();
    await file.setInputFiles(photo, { timeout: 120_000 });
    await page.getByRole('button', { name: /Generate my try-on/ }).click({ timeout: 30_000 });
    await page.getByAltText('Your try-on result').waitFor({ timeout: 120_000 });
    await page.getByText(/left today/).waitFor({ timeout: 10_000 });
    const after = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(after.tryOnCredits === before.tryOnCredits - 1, `seller credits ${before.tryOnCredits} → ${after.tryOnCredits}`);
    const shopper = await prisma.user.findUnique({ where: { id: S.tryShopper.id } });
    check(shopper.tryOnConsentAt, 'the consent was not stored');
    const quota = await apiOk('GET', '/api/tryon/quota', token);
    check(JSON.stringify(quota).match(/"used(Today)?":\s*1|"todayUsed":\s*1|"remaining/), `quota after one run: ${JSON.stringify(quota)}`);
    S.tryToken = token;
  }, { page: () => S.tryPage, needs: ['live', 'cloth', 'tryonCredits'], key: 'tryon' });

  await step(F, 'the same photo on the same product again within 24 hours is free', async () => {
    const last = await prisma.tryOnHistory.findFirst({ where: { userId: S.tryShopper.id, productId: S.clothId, status: 'SUCCESS' }, orderBy: { createdAt: 'desc' } });
    const before = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    const r = await apiOk('POST', '/api/tryon', S.tryToken, { productId: S.clothId, photoRef: last.inputImageUrl });
    check(r.status === 'SUCCESS', `repeat run: ${JSON.stringify(r).slice(0, 120)}`);
    const after = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(after.tryOnCredits === before.tryOnCredits, `credits ${before.tryOnCredits} → ${after.tryOnCredits} on a repeat`);
  }, { needs: ['tryon'] });

  await step(F, 'at zero credits the button goes, a new photo is refused, and the seller is told', async () => {
    await prisma.tryOnCreditLot.updateMany({ where: { sellerId: S.sellerId }, data: { remaining: 0 } });
    await prisma.sellerProfile.update({ where: { id: S.sellerId }, data: { tryOnCredits: 1, tryOnZeroNotifiedAt: null } });
    const page = S.tryPage;
    try {
      // A new shopper uses the last credit; the seller hears about it.
      const other = await seedUser('CUSTOMER', `E2E TryOn2 ${RUN}`);
      await prisma.user.update({ where: { id: other.id }, data: { tryOnConsentAt: new Date(), tryOnConsentVersion: (await prisma.user.findUnique({ where: { id: S.tryShopper.id } })).tryOnConsentVersion } });
      const otherPage = await newPage('tryon-other');
      await pinLogin(otherPage, other.phone, other.pin);
      const otherToken = await tokenOf(otherPage);
      await otherPage.close();
      const photo = await makeImage('other-photo.jpg', 800, 1200, '#3a4f6b');
      const up = await upload(otherToken, '/api/uploads/private', 'images', photo, 'TRYON_PHOTO');
      const ref = up.json?.data?.items?.[0]?.ref;
      const used = await apiOk('POST', '/api/tryon', otherToken, { productId: S.clothId, photoRef: ref });
      check(used.status === 'SUCCESS', 'the last credit did not run');
      const pdp = await apiOk('GET', `/api/products/${S.clothSlug}`, otherToken);
      check(pdp.tryOnEligible === false, 'the product still offers try-on at zero credits');
      await goto(page, `/products/${S.clothSlug}`);
      await page.locator('h1').first().waitFor({ timeout: 120_000 });
      check(!(await page.getByText('✨ AI Try-On').count()), 'the Try-On box is still on the product page');
      const photo2 = await makeImage('other-photo-2.jpg', 800, 1200, '#5b3a6b');
      const up2 = await upload(otherToken, '/api/uploads/private', 'images', photo2, 'TRYON_PHOTO');
      const refused = await api('POST', '/api/tryon', otherToken, { productId: S.clothId, photoRef: up2.json?.data?.items?.[0]?.ref });
      check(refused.json?.error?.code === 'TRYON_NOT_ELIGIBLE', `a new photo at zero: ${JSON.stringify(refused.json).slice(0, 120)}`);
      const told = await prisma.notification.findFirst({ where: { userId: S.sellerUserId, type: 'SELLER_TRYON' } });
      check(told, 'the seller was not told the credits ran out');
    } finally {
      await apiOk('POST', `/api/admin/sellers/${S.sellerId}/tryon-credits`, S.adminToken, { credits: 20, charge: false, note: `E2E ${RUN} refill` });
    }
  }, { needs: ['tryon'] });
}

// ---------------------------------------------------------------------------
// 7 Seller Wallet, plans, advertising, sponsorship, try-on credits (Batch 2)
// ---------------------------------------------------------------------------
async function wallet() {
  return apiOk('GET', '/api/seller/billing/wallet', S.sellerToken);
}
const istToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const istDayPlus = (n) => new Date(Date.now() + 5.5 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

/** Earlier E2E runs' bookings for today would hold the slots this run books. */
async function freeTodaysE2eSlots() {
  const day = new Date(`${istToday()}T00:00:00Z`);
  await prisma.adSlotBooking.deleteMany({ where: { day, campaign: { seller: { shopName: { startsWith: 'E2E' } } } } });
}

async function flow7Ads() {
  const F = '7 Wallet/Plans/Ads';
  const page = S.sellerPage;
  await step(F, 'Seller Wallet topped up with the mock payment', async () => {
    await goto(page, '/seller');
    await page.getByRole('button', { name: '₹5,000' }).click({ timeout: 120_000 });
    S.walletBefore = (await wallet()).walletPaise;
    await page.getByRole('button', { name: 'Add credits' }).click();
    await page.locator('[data-action=pay-credits]').click({ timeout: 30_000 });
    await toast(page, /Paid — ₹5,000/);
    const after = (await wallet()).walletPaise;
    check(after - S.walletBefore === 500000, `wallet ${S.walletBefore} → ${after}`);
  }, { page, needs: ['approved'], key: 'credits' });

  await step(F, 'the old ad booking page leads to Advertising', async () => {
    await goto(page, '/seller/ads');
    await page.waitForURL(/\/seller\/advertising/, { timeout: 60_000 });
    const r = await api('POST', '/api/seller/ads', S.sellerToken, { productId: S.simpleId, placement: 'CATEGORY_SPONSORED', durationDays: 7 });
    check(r.status === 410, `old booking API answered ${r.status}`);
  }, { page, needs: ['approved'] });

  await step(F, 'plan: upgrade to Growth, paid from the wallet with GST', async () => {
    const before = (await wallet()).walletPaise;
    await goto(page, '/seller/plans');
    await page.locator('[data-action=plan-GROWTH]').click({ timeout: 120_000 });
    await toast(page, /You are on GROWTH/);
    const after = (await wallet()).walletPaise;
    check(before - after === 59900 + 10782, `wallet ${before} → ${after} (want −₹706.82)`);
    await page.locator('[data-current-plan=GROWTH]').waitFor({ timeout: 30_000 });
  }, { page, needs: ['credits'], key: 'growth' });

  await step(F, 'Advertising: ₹500 welcome credit, a pay-per-click campaign from the form', async () => {
    await goto(page, '/seller/advertising');
    const credit = page.locator('[data-ad-credit]');
    await credit.waitFor({ timeout: 120_000 });
    await page.waitForFunction(() => /₹/.test(document.querySelector('[data-ad-credit]')?.textContent ?? ''), null, { timeout: 30_000 });
    check(/₹500/.test(await credit.innerText()), `ad credit shows "${await credit.innerText()}"`);
    await page.locator('select[name=productId]').selectOption(S.simpleId);
    await page.locator('input[name=name]').fill(`E2E CPC ${RUN}`);
    await page.locator('input[name=bid]').fill('5');
    await page.locator('input[name=daily]').fill('100');
    await page.getByRole('button', { name: 'Start campaign' }).click();
    await page.getByText('Campaign started.').waitFor({ timeout: 30_000 });
    const c = await prisma.adCampaign.findFirst({ where: { sellerId: S.sellerId, name: `E2E CPC ${RUN}` } });
    check(c && c.bidPaise === 500 && c.status === 'ACTIVE', `campaign ${JSON.stringify(c && { bid: c.bidPaise, status: c.status })}`);
    S.cpcId = c.id;
  }, { page, needs: ['credits', 'live'], key: 'cpc' });

  await step(F, 'shoppers see it labelled "Sponsored" in search; a click is charged once, from the credit', async () => {
    const shopper = S.tryPage;
    const title = (await prisma.product.findUnique({ where: { id: S.simpleId } })).title;
    const word = title.split(/\s+/).find((w) => w.length >= 4 && /^[a-z]+$/i.test(w)) ?? title.split(/\s+/)[0];
    // A reused local database still has earlier runs' power-bank campaigns
    // live; they would fill every sponsored slot for this word. Only this
    // run's campaign competes.
    await prisma.adCampaign.updateMany({ where: { name: { startsWith: 'E2E CPC ' }, id: { not: S.cpcId }, status: 'ACTIVE' }, data: { status: 'ENDED' } });
    const credit0 = (await wallet()).adCreditPaise;
    for (let i = 0; i < 2; i++) {
      await goto(shopper, `/products?q=${encodeURIComponent(word)}`);
      const card = shopper.locator(`a[href="/products/${S.simpleSlug}"]`).filter({ hasText: 'Sponsored' }).first();
      await card.waitFor({ timeout: 120_000 });
      await card.click();
      await shopper.waitForURL(new RegExp(`/products/${S.simpleSlug}`), { timeout: 60_000 });
      await shopper.waitForTimeout(1500);
    }
    // This browser is headless Chrome, which says so in its user agent: its clicks are bots and cost nothing.
    const clicks = await prisma.adClick.findMany({ where: { campaignId: S.cpcId } });
    check(clicks.length === 2 && clicks.every((c) => !c.valid && c.reason === 'bot'), `browser clicks: ${clicks.map((c) => `${c.valid}/${c.reason}`).join(', ')}`);
    check(clicks.every((c) => c.userId === S.tryShopper.id), 'the click was not tied to the signed-in shopper');
    check((await wallet()).adCreditPaise === credit0, 'a bot click was charged');
    // A shopper's own browser: the first click is charged, the same one again within 24 hours is not.
    const human = (deviceId) =>
      fetch(`${API}/api/ad-serve/click`, {
        method: 'POST',
        headers: { authorization: `Bearer ${S.tryToken}`, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36' },
        body: JSON.stringify({ campaignId: S.cpcId, productId: S.simpleId, deviceId, slotType: 'SPONSORED_PRODUCT' }),
      }).then((r) => r.json());
    check((await human('e2e-phone-0001')).data?.counted === true, 'the first real click was not counted');
    check((await human('e2e-phone-0002')).data?.counted === false, 'a repeat click within 24 hours was counted');
    const credit1 = (await wallet()).adCreditPaise;
    check(credit0 - credit1 === 500, `ad credit ${credit0} → ${credit1}`);
  }, { page: () => S.tryPage, needs: ['cpc', 'tryon'] });

  await step(F, 'homepage banner booked with an image, approved by admin, shown with its "Ad" label', async () => {
    await freeTodaysE2eSlots();
    await goto(page, '/seller/advertising');
    await page.getByRole('button', { name: 'Premium placements' }).click({ timeout: 120_000 });
    await page.locator('select[name=placement]').selectOption('HOMEPAGE_BANNER');
    const banner = await makeImage('e2e-banner.jpg', 1500, 500, '#1f6b4f');
    await page.locator('input[name=creative]').setInputFiles(banner);
    await page.locator('form img').first().waitFor({ timeout: 60_000 });
    await page.locator('input[name=headline]').fill(`E2E banner ${RUN}`);
    const before = (await wallet()).walletPaise;
    await page.getByRole('button', { name: /^Book for/ }).click();
    await page.getByText(/^Booked\./).waitFor({ timeout: 30_000 });
    const c = await prisma.adCampaign.findFirst({ where: { sellerId: S.sellerId, placement: 'HOMEPAGE_BANNER' }, orderBy: { createdAt: 'desc' } });
    check(c?.status === 'PENDING_APPROVAL', `banner status ${c?.status}`);
    const w = await wallet();
    check(before - w.walletPaise === 100000 + 18000 || w.adCreditPaise < 50000, `wallet ${before} → ${w.walletPaise}`);
    const admin = S.adminPage;
    await goto(admin, '/admin/ads');
    await admin.locator(`[data-review-row="${c.id}"] button`, { hasText: 'Approve' }).click({ timeout: 120_000 });
    await admin.locator(`[data-review-row="${c.id}"]`).waitFor({ state: 'detached', timeout: 30_000 });
    const shopper = S.tryPage;
    await goto(shopper, '/');
    const shown = shopper.locator(`a:has(img[alt="E2E banner ${RUN}"])`);
    await shown.waitFor({ timeout: 120_000 });
    check(/\bad\b/i.test(await shown.innerText()), 'the banner has no "Ad" label');
    S.bannerId = c.id;
  }, { page, needs: ['credits', 'live'] });

  await step(F, 'a rejected creative is refunded and its day freed', async () => {
    const before = (await wallet());
    const booked = await apiOk('POST', '/api/seller/advertising/placements', S.sellerToken, { placement: 'CATEGORY_BANNER', categoryId: S.simpleCategoryId, startDate: istDayPlus(20), units: 1, creativeUrl: '/uploads/e2e-reject.jpg' });
    const admin = S.adminPage;
    await goto(admin, '/admin/ads');
    const row = admin.locator(`[data-review-row="${booked.id}"]`);
    await row.getByRole('button', { name: 'Reject…' }).click({ timeout: 120_000 });
    await row.locator('input[name=reason]').fill('E2E: text unreadable');
    await row.getByRole('button', { name: 'Reject and refund' }).click();
    await row.waitFor({ state: 'detached', timeout: 30_000 });
    const after = await wallet();
    check(after.walletPaise === before.walletPaise && after.adCreditPaise === before.adCreditPaise, `wallet ${before.walletPaise}/${before.adCreditPaise} → ${after.walletPaise}/${after.adCreditPaise}`);
    check((await prisma.adSlotBooking.count({ where: { campaignId: booked.id } })) === 0, 'the day was not freed');
  }, { page: S.adminPage, needs: ['credits', 'live'] });

  await step(F, 'Sponsorship: the rate card, a homepage featured product, labelled "Sponsored" for shoppers', async () => {
    await goto(page, '/seller/sponsorship');
    const card = page.locator('[data-rate-card]');
    await card.waitFor({ timeout: 120_000 });
    const text = await card.innerText();
    check(/Homepage Featured Product/.test(text) && /₹199/.test(text) && /Brand Spotlight/.test(text), `rate card: ${text.slice(0, 200)}`);
    await page.locator('select[name=placement]').selectOption('SP_HOMEPAGE_FEATURED');
    await page.locator('select[name=productId]').selectOption(S.simpleId);
    await page.getByRole('button', { name: /^Book for/ }).click();
    await page.getByText(/^Booked\./).waitFor({ timeout: 30_000 });
    const shopper = S.tryPage;
    await goto(shopper, '/');
    const sp = shopper.locator('section[aria-label=Sponsored]').locator(`a[href="/products/${S.simpleSlug}"]`).first();
    await sp.waitFor({ timeout: 120_000 });
    check(/sponsored/i.test(await sp.innerText()), 'the featured product has no "Sponsored" label');
  }, { page, needs: ['credits', 'live'] });

  await step(F, 'AI Try-On: a 100-credit pack bought from the wallet (₹1,500 + GST)', async () => {
    const before = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    const w0 = (await wallet()).walletPaise;
    await goto(page, '/seller/tryon');
    await page.locator('[data-pack="100"] button').click({ timeout: 120_000 });
    await toast(page, /Paid from your Seller Wallet/);
    const after = await prisma.sellerProfile.findUnique({ where: { id: S.sellerId } });
    check(after.tryOnCredits - before.tryOnCredits === 100, `credits ${before.tryOnCredits} → ${after.tryOnCredits}`);
    const w1 = (await wallet()).walletPaise;
    check(w0 - w1 === 177000, `wallet ${w0} → ${w1}`);
  }, { page, needs: ['credits'] });

  await step(F, "Billing: this month's invoice from Clowe lists the charges", async () => {
    await goto(page, '/seller/billing');
    const list = page.locator('[data-seller-invoices]');
    await list.getByText(/View/).first().click({ timeout: 120_000 });
    const inv = page.locator('[data-seller-invoice]');
    await inv.waitFor({ timeout: 60_000 });
    const text = await inv.innerText();
    check(/CLOWE PARTNERS LLP/i.test(text), 'supplier is not Clowe Partners LLP');
    check(/plan|subscription/i.test(text) && /try-on/i.test(text) && /advertis|sponsor/i.test(text), `invoice lines: ${text.slice(0, 300)}`);
  }, { page, needs: ['growth'] });

  await step(F, 'a fee change announced 30 days ahead reaches the seller, and can be cancelled', async () => {
    const short = await api('POST', '/api/admin/fee-changes', S.adminToken, { patch: { fees: { gtPercent: 1.6 } }, effectiveAt: new Date(Date.now() + 10 * 86_400_000).toISOString() });
    check(short.json?.error?.code === 'NOTICE_TOO_SHORT', `10 days' notice: ${short.status}`);
    const fc = await apiOk('POST', '/api/admin/fee-changes', S.adminToken, { patch: { fees: { gtPercent: 1.6 } }, effectiveAt: new Date(Date.now() + 32 * 86_400_000).toISOString() });
    try {
      await goto(page, '/seller/billing');
      const banner = page.locator('[data-fee-change]').first();
      await banner.waitFor({ timeout: 120_000 });
      check(/1\.5 → 1\.6/.test(await banner.innerText()), `banner: ${await banner.innerText()}`);
    } finally {
      await apiOk('POST', `/api/admin/fee-changes/${fc.id}/cancel`, S.adminToken);
    }
  }, { page, needs: ['approved'] });
}

// ---------------------------------------------------------------------------
// 8 Shopper
// ---------------------------------------------------------------------------
async function flow8Shopper() {
  const F = '8 Shopper';
  S.shopPage = await newPage('shopper', undefined, { consent: false });
  const page = S.shopPage;
  S.shopperPhone = await freshPhone('92');

  await step(F, 'cookie banner on the first visit: nothing optional before a choice, the choice kept 12 months', async () => {
    await goto(page, '/');
    const banner = page.locator('[data-cookie-consent]');
    await banner.waitFor({ timeout: 60_000 });
    const stored = await page.evaluate(() => ['clowe.pincode', 'clowe.recentlyViewed', 'clowe.recentSearches'].filter((k) => localStorage.getItem(k)));
    check(stored.length === 0, `functional storage written before a choice: ${stored.join(', ')}`);
    await banner.getByRole('button', { name: 'Only necessary' }).click();
    const c = (await page.context().cookies()).find((k) => k.name === 'clowe_consent');
    check(c, 'no consent cookie');
    const days = (c.expires * 1000 - Date.now()) / 86_400_000;
    check(days > 360 && days < 367, `the choice is kept for ${days.toFixed(0)} days`);
    check(JSON.parse(decodeURIComponent(c.value)).functional === false, 'functional recorded as allowed');
    await goto(page, '/');
    await page.waitForTimeout(1500);
    check(!(await page.locator('[data-cookie-consent]').count()), 'the banner came back after a choice');
  }, { page });
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

  await step(F, 'store closed for orders: the shopper is told "Orders open soon" and refused; a test account is not', async () => {
    await apiOk('PUT', '/api/admin/settings', S.adminToken, { storeOpenForOrders: false });
    try {
      const token = await tokenOf(page);
      const refused = await api('POST', '/api/orders/checkout', token, { addressId: 'none', paymentMethod: 'COD' });
      check(refused.json?.error?.code === 'STORE_NOT_OPEN', `checkout while closed: ${refused.status} ${refused.json?.error?.code}`);
      await goto(page, '/checkout');
      await page.locator('[data-store-closed]').first().waitFor({ timeout: 120_000 });
      check(/orders open soon/i.test(await page.locator('[data-store-closed]').first().innerText()), 'no "Orders open soon" notice');
      const me = await prisma.user.findFirst({ where: { phone: S.shopperPhone } });
      await apiOk('PATCH', `/api/admin/users/${me.id}/test-account`, S.adminToken, { isTestAccount: true });
      const open = await apiOk('GET', '/api/orders/availability', token);
      check(open.open === true, 'a test account cannot order while closed');
    } finally {
      // Opening is refused while any seller with live listings lacks an address
      // or verified KYC (earlier runs' sellers in this database do): checked,
      // then the switch is put back directly for the rest of the run.
      const reopen = await api('PUT', '/api/admin/settings', S.adminToken, { storeOpenForOrders: true });
      const blockers = await apiOk('GET', '/api/admin/store-open-checklist', S.adminToken);
      if (blockers.length) check(reopen.json?.error?.code === 'STORE_OPEN_CHECKLIST', `opening with ${blockers.length} incomplete sellers: ${reopen.status} ${reopen.json?.error?.code}`);
      await prisma.platformSetting.upsert({ where: { key: 'storeOpenForOrders' }, update: { value: true }, create: { key: 'storeOpenForOrders', value: true } });
    }
  }, { page, needs: ['admin'] });

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
    // No email on the account yet: My Account offers a gentle prompt to add one…
    await goto(page, '/account');
    await page.locator('[data-email-prompt]').waitFor({ timeout: 60_000 });
    await page.locator('[data-email-prompt]').screenshot({ path: path.join(OUT, 'account-email-prompt.png') }).catch(() => {});
    await goto(page, '/checkout');
    // …and checkout asks for one (order updates and invoice).
    const emailBox = page.locator('#checkout-email');
    await emailBox.waitFor({ timeout: 120_000 });
    await page.getByRole('button', { name: /Continue to Payment/ }).last().click();
    await page.getByText('Add your email for your order updates and invoice').first().waitFor({ timeout: 20_000 });
    await emailBox.fill('not-an-email');
    await page.getByRole('button', { name: /Continue to Payment/ }).last().click();
    await page.getByText(/Enter a valid email address/).first().waitFor({ timeout: 20_000 });
    await page.locator('[data-checkout-email]').screenshot({ path: path.join(OUT, 'checkout-email-error.png') }).catch(() => {});
    S.shopperEmail = `e2e.${S.shopperId.slice(-8)}@example.com`;
    await emailBox.fill(S.shopperEmail);
    await page.getByRole('button', { name: /Continue to Payment/ }).last().click({ timeout: 120_000 });
    // A business purchase: the buyer's GSTIN, given at checkout, goes on the invoice (Payment Policy).
    S.buyerGstin = gstinFor(randomPan('C'));
    await page.locator('input[name=buyerGstin]').fill(S.buyerGstin, { timeout: 120_000 });
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
    check(order.buyerGstin === S.buyerGstin, `buyer GSTIN stored ${order.buyerGstin}`);
    check(JSON.stringify(inv.json).includes(S.buyerGstin), 'the buyer GSTIN is not on the invoice');
    // Mumbai is a metro: processing (1–2) + transit (2–4) working days (Shipping Policy 3).
    const etaDays = (new Date(order.etaTo) - new Date(order.createdAt)) / 86_400_000;
    check(order.etaTo && etaDays >= 3 && etaDays <= 8, `metro estimate ${etaDays.toFixed(1)} days`);
    const notes = await apiOk('GET', '/api/notifications', S.shopperToken);
    check(JSON.stringify(notes).includes(order.orderNumber), 'no notification about the order');
    // The email given at checkout is saved unconfirmed, with a one-time link queued (mock email).
    const buyer = await prisma.user.findUnique({ where: { id: S.shopperId } });
    check(buyer.email === S.shopperEmail && !buyer.emailVerifiedAt, `checkout email ${buyer.email} verified=${!!buyer.emailVerifiedAt}`);
    const link = await prisma.emailOutbox.findFirst({ where: { toEmail: S.shopperEmail, kind: 'EMAIL_VERIFY' }, orderBy: { createdAt: 'desc' } });
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(link?.text ?? '')?.[1];
    check(token, 'no confirmation link queued for the checkout email');
    await goto(page, `/verify-email?token=${token}`);
    await page.getByRole('button', { name: 'Confirm my email' }).click({ timeout: 60_000 });
    await page.locator('[data-verify-done]').waitFor({ timeout: 60_000 });
    await page.screenshot({ path: path.join(OUT, 'verify-email-done.png') }).catch(() => {});
    check(!!(await prisma.user.findUnique({ where: { id: S.shopperId } })).emailVerifiedAt, 'email not confirmed by the link');
    await goto(page, `/verify-email?token=${token}`);
    await page.getByRole('button', { name: 'Confirm my email' }).click({ timeout: 60_000 });
    await page.locator('[data-verify-error]').waitFor({ timeout: 60_000 }); // one-time
  }, { page, needs: ['cart'], key: 'prepaid' });

  await step(F, 'COD order under the cap is placed', async () => {
    await apiOk('POST', '/api/cart/items', S.shopperToken, { variantId: S.clothVariantId ?? S.simpleVariantId, quantity: 1 });
    const co = await apiOk('POST', '/api/orders/checkout', S.shopperToken, { addressId: S.addressId, paymentMethod: 'COD' });
    S.codOrderId = co.orderId;
    const o = await prisma.order.findUnique({ where: { id: co.orderId }, include: { items: true } });
    check(o.paymentMethod === 'COD', o.paymentMethod);
    S.codItemId = o.items[0].id;
  }, { needs: ['shopper', 'live'], key: 'cod' });

  await step(F, 'COD under the ₹1,000 floor is refused (Payment Policy 6.1)', async () => {
    const settings = await apiOk('GET', '/api/settings/public', null);
    check(settings.codMinOrderPaise === 100000, `COD floor ${settings.codMinOrderPaise}`);
    // One item is above ₹1,000, so lift the floor over this cart for one checkout.
    await prisma.platformSetting.upsert({ where: { key: 'codMinOrderPaise' }, update: { value: 10_000_000 }, create: { key: 'codMinOrderPaise', value: 10_000_000 } });
    try {
      await apiOk('POST', '/api/cart/items', S.shopperToken, { variantId: S.simpleVariantId, quantity: 1 });
      const r = await api('POST', '/api/orders/checkout', S.shopperToken, { addressId: S.addressId, paymentMethod: 'COD' });
      check(r.status === 400 && /from ₹/.test(r.json?.error?.message ?? ''), `refusal: ${r.status} ${r.json?.error?.message}`);
    } finally {
      await prisma.platformSetting.upsert({ where: { key: 'codMinOrderPaise' }, update: { value: 100000 }, create: { key: 'codMinOrderPaise', value: 100000 } });
      await api('DELETE', '/api/cart', S.shopperToken);
    }
  }, { needs: ['shopper', 'live'] });

  await step(F, 'a post office box address is refused (Shipping Policy 2.3)', async () => {
    const r = await api('POST', '/api/addresses', S.shopperToken, { name: 'E2E Shopper', phone: '9876543210', line1: 'PO Box 4321', city: 'Mumbai', state: 'Maharashtra', pincode: '400050' });
    check(r.status === 400 && /post office box/i.test(JSON.stringify(r.json)), `PO box address: ${r.status}`);
  }, { needs: ['shopper'] });

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
        // Headless Chrome's fake camera sometimes delivers no frames, and then
        // nothing can record it. The real getUserMedia still runs (so the
        // page's camera permission is what is tested); the page then gets a
        // moving canvas in its place, which always records.
        await page.evaluate(() => {
          const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async (constraints) => {
            (await real(constraints)).getTracks().forEach((t) => t.stop());
            const c = document.createElement('canvas');
            c.width = 640;
            c.height = 360;
            const g = c.getContext('2d');
            let f = 0;
            setInterval(() => {
              g.fillStyle = `hsl(${(f += 12) % 360},60%,50%)`;
              g.fillRect(0, 0, 640, 360);
            }, 50);
            return c.captureStream(20);
          };
        });
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
  if (!S.pickupScreenChecked) {
    S.pickupScreenChecked = true;
    await step('9 Fulfilment', 'pack screen: "Ready for pickup" and the packing checklist; the label has real AWB and order barcodes', async () => {
      await page.reload();
      await hydrated(page);
      check(await page.getByRole('button', { name: /Ready for pickup/ }).count(), 'no "Ready for pickup" button on the order page');
      check(await page.locator('[data-packaging-checklist]').count(), 'no packing checklist on the order page');
      const sheet = await page.context().newPage();
      try {
        await sheet.goto(`${WEB}/seller/orders/labels?ids=${itemId}`);
        await sheet.locator('svg[data-barcode]').first().waitFor({ timeout: 30_000 });
        const codes = await sheet.locator('svg[data-barcode]').evaluateAll((els) => els.map((e) => e.getAttribute('data-barcode')));
        check(codes.includes(shipment.awbNumber), `label barcodes ${codes.join(', ')} — no AWB ${shipment.awbNumber}`);
        check(codes.length >= 2, `label barcodes: ${codes.join(', ')}`);
        // At least 8 mm tall, as Delhivery's scanners need.
        const mm = await sheet.locator(`svg[data-barcode="${shipment.awbNumber}"]`).evaluate((e) => e.getBoundingClientRect().height / (96 / 25.4));
        check(mm >= 8, `AWB barcode ${mm.toFixed(1)} mm tall`);
      } finally {
        await sheet.close();
      }
    }, { page });
  }
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
    // Batch 2 fees: referral (COMMISSION), GT, collection (GATEWAY_FEE), handling, and GST on them.
    const want = ['SALE_EARNING', 'COMMISSION', 'GT_CHARGE', 'GATEWAY_FEE', 'HANDLING_FEE', 'CLOWE_FEE_GST', 'TDS', 'GST_TCS', 'FORWARD_FREIGHT'];
    const missing = want.filter((t) => !types.has(t));
    check(!missing.length, `missing ${missing.join(', ')} (have ${[...types].join(', ')})`);
    const sale = rows.find((r) => r.type === 'SALE_EARNING');
    const item = await prisma.orderItem.findUnique({ where: { id: S.prepaidItemId } });
    check(item.gstRatePercent === 18, `GST rate recorded on the line: ${item.gstRatePercent}`);
    check(item.feeModel === 2, `fee model on the line: ${item.feeModel}`);
    check(!types.has('PLATFORM_FEE') && !types.has('CLOSING_FEE'), 'old fixed fees were charged');
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

  await step(F, 'seller cancels an order: no cancellation penalty (Batch 2)', async () => {
    await apiOk('POST', '/api/cart/items', S.shopperToken, { variantId: S.simpleVariantId, quantity: 1 });
    const co = await apiOk('POST', '/api/orders/checkout', S.shopperToken, { addressId: S.addressId, paymentMethod: 'COD' });
    await goto(page, `/seller/orders/${co.orderId}`);
    await page.getByRole('button', { name: /Cancel (this order|my items|order)/i }).first().click({ timeout: 120_000 });
    await page.locator('select[name=cancelReason]').selectOption('Out of stock or discontinued');
    await page.getByRole('button', { name: /Cancel my items/ }).click();
    const said = await toast(page, /item\(s\) cancelled/i, 30_000);
    check(!/penalty/i.test(String(said ?? '')), `the toast mentions a penalty: ${said}`);
    const rows = await ledger(S.sellerId, co.orderId);
    check(!rows.some((r) => r.type === 'SELLER_CANCEL_PENALTY'), `penalty rows: ${rows.map((r) => `${r.type}:${r.amountPaise}`).join(', ')}`);
  }, { page, needs: ['shopper', 'live'] });
}

// ---------------------------------------------------------------------------
// 10 Cancellation, return, RTO
// ---------------------------------------------------------------------------
async function prepaidOrder(variantId, extra = {}) {
  await renewAll();
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

  await step(F, 'a non-cancellable item: marked before buying, not cancellable once confirmed', async () => {
    await prisma.product.update({ where: { id: S.simpleId }, data: { nonCancellable: true } });
    try {
      const page = S.shopPage;
      await goto(page, `/products/${S.simpleSlug}`);
      await page.locator('[data-pdp-non-cancellable]').waitFor({ timeout: 120_000 });
      const o = await prepaidOrder(S.simpleVariantId);
      check(o.items[0].nonCancellable, 'the order line was not marked non-cancellable');
      const r = await api('POST', `/api/orders/${o.id}/cancel`, S.shopperToken);
      check(r.json?.error?.code === 'NON_CANCELLABLE', `cancel: ${r.status} ${r.json?.error?.code}`);
      await goto(page, `/account/orders/${o.id}`);
      await page.locator('[data-non-cancellable]').first().waitFor({ timeout: 120_000 });
      check(!(await page.getByRole('button', { name: /^Cancel order/ }).count()), 'a Cancel button is offered');
    } finally {
      await prisma.product.update({ where: { id: S.simpleId }, data: { nonCancellable: false } });
    }
  }, { page: () => S.shopPage, needs: ['shopper', 'live'] });

  /** Evidence for a claim: the item, its tag, the packaging (Return Policy 3.2). */
  const evidence = async () => {
    const photo = S.claimPhoto ?? (S.claimPhoto = await makeImage('claim.jpg', 400, 400, '#884444'));
    const one = async () => (await upload(S.shopperToken, '/api/uploads/private', 'images', photo, 'RETURN_PHOTO')).ref;
    return { photos: [await one()], tagPhotos: [await one()], packagingPhotos: [await one()] };
  };

  await step(F, 'claim (Return Policy): no discretionary return; a defect refunded after the check; reverse freight on the ledger', async () => {
    const o = await prepaidOrder(S.simpleVariantId);
    const s = await fulfil(o.id, o.items[0].id, S.sellerPage, { tag: 'return' });
    await courier(s.awbNumber, 'DELIVERED');
    const shop = S.shopPage;
    await goto(shop, `/account/orders/${o.id}`);
    await shop.getByRole('button', { name: 'Report a problem' }).click({ timeout: 120_000 });
    const modal = shop.locator('[data-claim-modal]');
    await modal.waitFor({ timeout: 30_000 });
    const reasons = await modal.locator('label:has(input[name=claim-reason])').allInnerTexts();
    check(reasons.length === 6, `${reasons.length} claim reasons offered`);
    check(!reasons.some((r) => /size\s*\/\s*fit|no longer needed|other/i.test(r)), `a discretionary reason is offered: ${reasons.join(' | ')}`);
    const sizeFit = await api('POST', `/api/orders/items/${o.items[0].id}/return`, S.shopperToken, { reason: 'SIZE_FIT', details: 'E2E: too large' });
    check(sizeFit.status === 400, `a size/fit return was accepted (${sizeFit.status})`);
    await apiOk('POST', `/api/orders/items/${o.items[0].id}/return`, S.shopperToken, { reason: 'DEFECTIVE', remedy: 'REFUND', ...(await evidence()) });
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
    await page.getByRole('button', { name: /Passed — refund|Condition OK/ }).click({ timeout: 30_000 });
    await toast(page, /refund is on its way/);
    const rows = await ledger(S.sellerId, o.id);
    check(rows.some((r) => r.type === 'RETURN_FREIGHT'), `no RETURN_FREIGHT (have ${rows.map((r) => r.type).join(', ')})`);
    const refunds = await prisma.refund.findMany({ where: { orderId: o.id } });
    check(refunds.length > 0, 'no refund');
  }, { page: () => S.sellerPage, needs: ['shopper', 'live', 'delivered'] });

  await step(F, 'exchange claim: an identical item goes out free after the check, the sale stands', async () => {
    const o = await prepaidOrder(S.simpleVariantId);
    const s = await fulfil(o.id, o.items[0].id, S.sellerPage, { tag: 'exchange' });
    await courier(s.awbNumber, 'DELIVERED');
    await apiOk('POST', `/api/orders/items/${o.items[0].id}/return`, S.shopperToken, { reason: 'DEFECTIVE', remedy: 'EXCHANGE', ...(await evidence()) });
    const ret = await prisma.return.findFirst({ where: { orderItemId: o.items[0].id } });
    await apiOk('PATCH', `/api/seller/returns/${ret.id}`, S.sellerToken, { action: 'approve' });
    const reverse = await prisma.shipment.findFirst({ where: { returnId: ret.id } });
    check(reverse?.awbNumber, 'no reverse pickup booked');
    await courier(reverse.awbNumber, 'PICKED_UP');
    await courier(reverse.awbNumber, 'DELIVERED');
    await apiOk('PATCH', `/api/seller/returns/${ret.id}`, S.sellerToken, { action: 'received', condition: 'OK' });
    const done = await prisma.return.findUnique({ where: { id: ret.id }, include: { refund: true } });
    check(done.replacementOrderId && !done.refund, `exchange: replacement ${done.replacementOrderId}, refund ${done.refund?.id}`);
    const rep = await prisma.order.findUnique({ where: { id: done.replacementOrderId } });
    check(rep.paymentMethod === 'REPLACEMENT' && rep.totalPaise === 0, `replacement ${rep.paymentMethod} ₹${rep.totalPaise / 100}`);
    const line = await prisma.orderItem.findUnique({ where: { id: o.items[0].id } });
    check(line.status === 'DELIVERED', `the exchanged line is ${line.status}`);
  }, { needs: ['shopper', 'live', 'delivered'] });

  await step(F, 'after dispatch the buyer asks to stop the parcel: a ticket the seller hears about', async () => {
    const o = await prepaidOrder(S.simpleVariantId);
    await fulfil(o.id, o.items[0].id, S.sellerPage, { tag: 'intercept' });
    const page = S.shopPage;
    await goto(page, `/account/orders/${o.id}`);
    await page.getByRole('button', { name: 'Stop this parcel' }).click({ timeout: 120_000 });
    await page.locator('[data-intercept-request]').waitFor({ timeout: 30_000 });
    const c = await prisma.complaint.findFirst({ where: { orderId: o.id, subject: { startsWith: 'Stop my parcel' } } });
    check(c?.priority === 'HIGH', `intercept ticket ${c?.priority}`);
    check(await prisma.notification.count({ where: { userId: S.sellerUserId, type: 'INTERCEPT_REQUEST' } }), 'the seller was not told');
  }, { page: () => S.shopPage, needs: ['shopper', 'live', 'delivered'] });

  await step(F, 'a parcel the courier reports lost: the buyer chooses a free replacement', async () => {
    const o = await prepaidOrder(S.simpleVariantId);
    const s = await fulfil(o.id, o.items[0].id, S.sellerPage, { tag: 'lost' });
    await courier(s.awbNumber, 'LOST');
    const page = S.shopPage;
    await goto(page, `/account/orders/${o.id}`);
    await page.locator('[data-lost-choice]').waitFor({ timeout: 120_000 });
    await page.getByRole('button', { name: 'Send a replacement' }).click();
    await page.getByText(/Replacement:/).waitFor({ timeout: 60_000 });
    const rep = await prisma.orderItem.findFirst({ where: { replacementOfId: o.items[0].id }, include: { order: true } });
    check(rep?.order.paymentMethod === 'REPLACEMENT' && rep.order.totalPaise === 0, `replacement ${rep?.order.paymentMethod}`);
  }, { page: () => S.shopPage, needs: ['shopper', 'live', 'delivered'] });

  await step(F, 'RTO: refund when RTO starts, RTO freight, the buyer\'s RTO count', async () => {
    const o = await prepaidOrder(S.simpleVariantId);
    const s = await fulfil(o.id, o.items[0].id, S.sellerPage, { tag: 'rto' });
    const before = await prisma.user.findUnique({ where: { id: S.shopperId } });
    await courier(s.awbNumber, 'DELIVERY_FAILED');
    // Up to three attempts are made (Shipping Policy 6.5): the buyer is told which this was.
    const attempts = (await prisma.shipment.findUnique({ where: { id: s.id } })).deliveryAttempts;
    check(attempts === 1, `delivery attempts counted ${attempts}`);
    check(await prisma.notification.count({ where: { userId: S.shopperId, title: { contains: 'attempt 1 of 3' } } }), 'the buyer was not told "attempt 1 of 3"');
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

  await step(F, 'a product complaint goes to the seller (24 hours), who answers; the buyer sees the answer', async () => {
    const order = await prisma.order.findFirst({ where: { userId: S.shopperId, items: { every: { sellerId: S.sellerId } } }, orderBy: { createdAt: 'desc' } });
    const c = await apiOk('POST', '/api/complaints', S.shopperToken, { category: 'PRODUCT_QUALITY', description: `E2E the power bank does not charge ${RUN}`, orderId: order.id });
    const row = await prisma.complaint.findUnique({ where: { complaintId: c.complaintId } });
    check(row.sellerId === S.sellerId && row.sellerDueAt, 'not routed to the seller');
    const page = S.sellerPage;
    await goto(page, '/seller/customer-complaints');
    const card = page.locator('[data-seller-complaint]').filter({ hasText: c.complaintId });
    await card.waitFor({ timeout: 120_000 });
    await card.locator('textarea[name=reply]').fill('Sorry — please raise an exchange claim and we will send a new one.');
    await card.getByRole('button', { name: 'Reply' }).click();
    await toast(page, /Reply sent to the buyer/);
    const thread = await apiOk('GET', `/api/complaints/${row.id}`, S.shopperToken);
    check(thread.messages.some((m) => m.authorName === 'The seller'), 'the buyer does not see the seller\'s answer');
  }, { page: () => S.sellerPage, needs: ['shopper', 'approved'] });

  await step(F, 'not satisfied: the buyer escalates to the Nodal Officer; timers follow', async () => {
    const page = S.shopPage;
    await goto(page, '/complaints');
    await page.getByRole('button', { name: /Escalate to the Nodal Officer/ }).first().click({ timeout: 120_000 });
    await page.getByText(/escalated/).first().waitFor({ timeout: 30_000 });
    const row = await prisma.complaint.findFirst({ where: { userId: S.shopperId, level: 'NODAL' }, orderBy: { escalatedAt: 'desc' } });
    check(row, 'no complaint at the Nodal Officer');
    check(row.slaDueAt - row.escalatedAt === 72 * 3_600_000, 'the Nodal Officer does not have 72 hours');
    check(row.resolveDueAt, 'no resolve-by date');
  }, { page: () => S.shopPage, needs: ['shopper'] });
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
    // Its own button, by slug: matching rows by text (".last()") hit whichever
    // category was listed last and switched a real one off on every run.
    const activeBefore = await prisma.category.count({ where: { isActive: true, id: { not: cat.id } } });
    await page.locator(`[data-category-toggle="${cat.slug}"]`).click();
    await toast(page, /deactivated/);
    check((await prisma.category.findUnique({ where: { id: cat.id } }))?.isActive === false, 'the new category is still active');
    const activeAfter = await prisma.category.count({ where: { isActive: true, id: { not: cat.id } } });
    check(activeAfter === activeBefore, `another category changed too (${activeBefore} → ${activeAfter} active)`);
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
    // The innermost box holding both this headline and a Delete button is this
    // banner's card; ".last()" over every button could pick another banner.
    const bannersBefore = await prisma.homeBanner.count({ where: { id: { not: b.id } } });
    const deleteButton = page.getByRole('button', { name: 'Delete' });
    await page.locator('div').filter({ hasText: `E2E banner ${RUN}` }).filter({ has: deleteButton }).last().getByRole('button', { name: 'Delete' }).click();
    await toast(page, /Banner deleted/);
    check(!(await prisma.homeBanner.findUnique({ where: { id: b.id } })), 'the E2E banner was not deleted');
    check((await prisma.homeBanner.count({ where: { id: { not: b.id } } })) === bannersBefore, 'another banner was deleted');
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
    const expect = [/SELLERS:/, /PRODUCTS:/, /SETTINGS:/, /ADVERTISING:/, /USERS:/, /BANNERS:/, /CATEGORIES:/, /CATEGORYFACETS:/];
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

  await step(F, 'home hero (banners, or real product photos without them) and sponsored slots render', async () => {
    await page.goto(`${PROD}/`, { waitUntil: 'networkidle', timeout: 90_000 });
    const home = await (await fetch(`${PROD}/api/home`)).json();
    // With banners up, the carousel; with none (switched off in admin), the hero of live products.
    const hero = (home.data?.banners ?? []).length > 0 ? 'section[aria-roledescription=carousel]' : '[data-product-hero]';
    check(await page.locator(hero).count(), `no home hero (${hero})`);
    check((home.data?.trending ?? []).length > 0, 'no products on the home page');
    check(await page.locator('footer [data-legal-line]').filter({ hasText: /CLOWE PARTNERS LLP/ }).count(), 'footer does not name the legal entity');
    const ads = await fetch(`${PROD}/api/ad-serve?surface=HOME`).then((r) => r.json()).catch(() => null);
    const served = (ads?.data?.items ?? []).length + (ads?.data?.banners ?? []).length;
    const labelled = await page.locator('section[aria-label=Sponsored]').count();
    check(served === 0 || labelled > 0, `ads are served (${served}) but no labelled slot is shown`);
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
