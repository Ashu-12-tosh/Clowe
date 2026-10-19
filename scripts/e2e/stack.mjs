// ---------------------------------------------------------------------------
// The local stack for end-to-end runs: its own API and web dev servers on
// spare ports, every provider forced to its mock, the dev database.
//
// Safety: whatever .env / .env.local say, this process environment wins
// (dotenv and Next never override a variable that is already set), so:
//   OTP, payments, KYC, try-on (FASHN), AI, messaging, shipping → mock;
//   the Delhivery and FASHN keys are blanked, so nothing paid can be called.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'apps', 'api', 'package.json'));
/** require() from the API workspace (sharp, @prisma/client, …). */
export const apiRequire = require;

export const API_PORT = Number(process.env.E2E_API_PORT ?? 4600);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4700);
export const API = `http://localhost:${API_PORT}`;
export const WEB = `http://localhost:${WEB_PORT}`;

/** The mock-only environment both servers run with. */
export const MOCK_ENV = {
  NODE_ENV: 'development',
  PORT: String(API_PORT),
  API_PUBLIC_URL: API,
  CORS_ORIGINS: WEB,
  OTP_PROVIDER: 'mock',
  PAYMENT_PROVIDER: 'mock',
  PAYOUT_PROVIDER: 'mock',
  SETTLEMENT_MODE: 'payouts',
  KYC_PROVIDER: 'mock',
  TRYON_PROVIDER: 'mock',
  AI_PROVIDER: 'mock',
  MESSAGING_PROVIDER: 'mock',
  SHIPPING_PROVIDER: 'mock',
  EMAIL_PROVIDER: 'mock',
  STORAGE_PROVIDER: 'local',
  DELHIVERY_ENV: 'staging',
  DELHIVERY_PRODUCTION_WRITES: 'false',
  // Blank keys: no real provider can be reached even by mistake.
  DELHIVERY_API_TOKEN: '',
  DELHIVERY_BASE_URL: '',
  FASHN_API_KEY: '',
  GEMINI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  SMS_PANEL_API_KEY: '',
  SMTP_PASSWORD: '',
  CASHFREE_VERIFICATION_CLIENT_ID: '',
  CASHFREE_VERIFICATION_CLIENT_SECRET: '',
  CASHFREE_PG_CLIENT_ID: '',
  CASHFREE_PG_CLIENT_SECRET: '',
  CASHFREE_PAYOUT_CLIENT_ID: '',
  CASHFREE_PAYOUT_CLIENT_SECRET: '',
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  NEXT_PUBLIC_API_URL: API,
  // The web dev server forwards /api and /uploads here (next.config rewrites).
  API_PROXY_TARGET: API,
  NEXT_PUBLIC_SITE_URL: WEB,
  NEXT_TELEMETRY_DISABLED: '1',
};

/** Fail fast if anything would reach a paid provider. */
export function assertMockOnly(env) {
  const wrong = Object.entries({
    OTP_PROVIDER: 'mock',
    PAYMENT_PROVIDER: 'mock',
    PAYOUT_PROVIDER: 'mock',
    KYC_PROVIDER: 'mock',
    TRYON_PROVIDER: 'mock',
    AI_PROVIDER: 'mock',
    SHIPPING_PROVIDER: 'mock',
    DELHIVERY_ENV: 'staging',
    EMAIL_PROVIDER: 'mock',
  }).filter(([k, v]) => env[k] !== v);
  if (wrong.length || env.DELHIVERY_API_TOKEN || env.DELHIVERY_BASE_URL || env.FASHN_API_KEY || env.GEMINI_API_KEY || env.SMTP_PASSWORD || env.CASHFREE_PG_CLIENT_SECRET || env.CASHFREE_PAYOUT_CLIENT_SECRET) {
    throw new Error(`refusing to run: not mock-only (${wrong.map(([k]) => k).join(', ') || 'a provider key is set'})`);
  }
}

async function waitFor(url, label, ms) {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not come up at ${url} (${last})`);
}

/** Start the API and web; returns { stop, apiLog, webLog }. */
export async function startStack({ log = () => {} } = {}) {
  const env = { ...process.env, ...MOCK_ENV };
  assertMockOnly(env);
  const apiLog = [];
  const webLog = [];
  const shell = process.platform === 'win32';
  const api = spawn('npx', ['tsx', 'src/index.ts'], { cwd: path.join(ROOT, 'apps', 'api'), env, shell });
  api.stdout.on('data', (d) => apiLog.push(String(d)));
  api.stderr.on('data', (d) => apiLog.push(String(d)));
  const web = spawn('npx', ['next', 'dev', '-p', String(WEB_PORT)], { cwd: path.join(ROOT, 'apps', 'web'), env, shell });
  web.stdout.on('data', (d) => webLog.push(String(d)));
  web.stderr.on('data', (d) => webLog.push(String(d)));

  const stop = () => {
    for (const child of [api, web]) {
      if (child.exitCode !== null) continue;
      // Synchronous, so the servers are gone even if the caller exits right after.
      if (shell) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
  };
  try {
    log(`starting API on ${API_PORT} and web on ${WEB_PORT} (mock providers only)`);
    await waitFor(`${API}/api/health`, 'API', 120_000);
    await waitFor(`${WEB}/`, 'web', 240_000);
  } catch (err) {
    stop();
    err.message += `\n--- api log ---\n${apiLog.join('').slice(-3000)}\n--- web log ---\n${webLog.join('').slice(-3000)}`;
    throw err;
  }
  // The API says which providers it booted with: double-check nothing is real.
  const boot = apiLog.join('');
  if (/Shipping: Delhivery/i.test(boot) && !/mock Delhivery/i.test(boot)) {
    stop();
    throw new Error('refusing to run: the API booted with real Delhivery');
  }
  return { stop, apiLog, webLog };
}

export function prismaClient() {
  const { PrismaClient } = require('@prisma/client');
  return new PrismaClient();
}

/** The local JWT secret (never printed). */
export function jwtSecret() {
  const dotenv = require('dotenv');
  const parsed = {
    ...dotenv.config({ path: path.join(ROOT, 'apps', 'api', '.env'), processEnv: {} }).parsed,
    ...dotenv.config({ path: path.join(ROOT, 'apps', 'api', '.env.local'), processEnv: {} }).parsed,
  };
  if (!parsed.JWT_ACCESS_SECRET) throw new Error('JWT_ACCESS_SECRET missing in apps/api/.env');
  return parsed.JWT_ACCESS_SECRET;
}

/** A PIN hash as the API stores it. */
export function pinHash(userId, pin) {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(`${userId}:${pin}:${jwtSecret()}`).digest('hex');
}

export function accessToken(userId, role) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ sub: userId, role }, jwtSecret(), { expiresIn: '120m', issuer: 'clowe-api' });
}

export function playwright() {
  return require(path.join(ROOT, 'node_modules', 'playwright'));
}
