import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { envRules as EnvRules } from '../../env';

/**
 * Which Cashfree settings the server agrees to start with. Live Cashfree
 * (real money) only from the production server; never from a developer
 * machine or a test run, and a test run never on a real gateway at all. A
 * gateway switched on without its keys refuses to start rather than fall back.
 */

const BASE = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'test-secret-0123456789' };
const PROD = { ...BASE, NODE_ENV: 'production', KYC_FINGERPRINT_SECRET: 'production-fingerprint-secret-0123456789' };
const KEYS = { CASHFREE_PG_CLIENT_ID: 'id', CASHFREE_PG_CLIENT_SECRET: 'secret' };
const PAYOUT_KEYS = { CASHFREE_PAYOUT_CLIENT_ID: 'pid', CASHFREE_PAYOUT_CLIENT_SECRET: 'psecret' };

// env.ts checks the process environment as it loads, so it is given a valid
// one first; the rules are then exercised on plain objects.
let envRules: typeof EnvRules;
beforeAll(async () => {
  for (const [k, v] of Object.entries({ ...BASE, NODE_ENV: 'development', PAYMENT_PROVIDER: 'mock', PAYOUT_PROVIDER: 'mock' })) vi.stubEnv(k, v);
  ({ envRules } = await import('../../env'));
}, 60_000);
afterAll(() => vi.unstubAllEnvs());

const problems = (vars: Record<string, string>) => {
  const r = envRules.safeParse(vars);
  return r.success ? [] : r.error.issues.map((i) => String(i.path[0]));
};

describe('the Cashfree settings', () => {
  it('default to the mocks, sandbox, and settlement by payouts', () => {
    const r = envRules.parse({ ...BASE, NODE_ENV: 'development' });
    expect(r.PAYMENT_PROVIDER).toBe('mock');
    expect(r.PAYOUT_PROVIDER).toBe('mock');
    expect(r.CASHFREE_PG_ENV).toBe('sandbox');
    expect(r.CASHFREE_PAYOUT_ENV).toBe('sandbox');
    expect(r.SETTLEMENT_MODE).toBe('payouts');
  });

  it('take blank values (compose passes "") as unset', () => {
    const r = envRules.parse({ ...BASE, NODE_ENV: 'development', CASHFREE_PG_ENV: '', PAYOUT_PROVIDER: '', SETTLEMENT_MODE: '', CASHFREE_PG_CLIENT_ID: '' });
    expect(r.CASHFREE_PG_ENV).toBe('sandbox');
    expect(r.PAYOUT_PROVIDER).toBe('mock');
    expect(r.CASHFREE_PG_CLIENT_ID).toBeUndefined();
  });

  it('allow the sandbox anywhere but a test run', () => {
    expect(problems({ ...BASE, NODE_ENV: 'development', PAYMENT_PROVIDER: 'cashfree', ...KEYS })).toEqual([]);
    expect(problems({ ...BASE, NODE_ENV: 'development', PAYOUT_PROVIDER: 'cashfree', ...PAYOUT_KEYS })).toEqual([]);
    expect(problems({ ...BASE, NODE_ENV: 'test', PAYMENT_PROVIDER: 'cashfree', ...KEYS })).toContain('PAYMENT_PROVIDER');
    expect(problems({ ...BASE, NODE_ENV: 'test', PAYOUT_PROVIDER: 'cashfree', ...PAYOUT_KEYS })).toContain('PAYOUT_PROVIDER');
  });

  it('refuse live Cashfree anywhere but the production server', () => {
    for (const key of ['CASHFREE_PG_ENV', 'CASHFREE_PAYOUT_ENV', 'CASHFREE_VERIFICATION_ENV']) {
      expect(problems({ ...BASE, NODE_ENV: 'development', [key]: 'production' })).toContain(key);
      expect(problems({ ...BASE, NODE_ENV: 'test', [key]: 'production' })).toContain(key);
      expect(problems({ ...PROD, [key]: 'production' })).toEqual([]);
    }
  });

  it('refuse a gateway switched on without its keys, and Easy Split without the Cashfree gateway', () => {
    expect(problems({ ...PROD, PAYMENT_PROVIDER: 'cashfree' })).toContain('CASHFREE_PG_CLIENT_ID');
    expect(problems({ ...PROD, PAYMENT_PROVIDER: 'cashfree', CASHFREE_PG_CLIENT_ID: 'id' })).toContain('CASHFREE_PG_CLIENT_ID');
    expect(problems({ ...PROD, PAYOUT_PROVIDER: 'cashfree' })).toContain('CASHFREE_PAYOUT_CLIENT_ID');
    expect(problems({ ...PROD, SETTLEMENT_MODE: 'easy_split' })).toContain('SETTLEMENT_MODE');
    expect(problems({ ...PROD, SETTLEMENT_MODE: 'easy_split', PAYMENT_PROVIDER: 'cashfree', ...KEYS })).toEqual([]);
  });
});
