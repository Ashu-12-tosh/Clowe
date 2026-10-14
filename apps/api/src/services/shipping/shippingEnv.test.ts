import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Which courier connection the settings give. The mock unless told
 * otherwise; Delhivery staging unless told production; and live Delhivery
 * stays read-only unless production writes are switched on as well.
 */

const BASE = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'test-secret-0123456789' };

async function load(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({
    ...BASE,
    SHIPPING_PROVIDER: undefined,
    DELHIVERY_ENV: undefined,
    DELHIVERY_API_TOKEN: undefined,
    DELHIVERY_PRODUCTION_WRITES: undefined,
    ...vars,
  })) {
    vi.stubEnv(k, v);
  }
  const { env } = await import('../../env');
  const { shippingProvider } = await import('./index');
  return { env, shippingProvider };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// Each test loads the API's modules afresh (Prisma included): slow on a busy machine.
describe('the shipping settings', { timeout: 60_000 }, () => {
  it('default to the mock, staging, and no production writes', async () => {
    const { env, shippingProvider } = await load({});
    expect(env).toMatchObject({ SHIPPING_PROVIDER: 'mock', DELHIVERY_ENV: 'staging', DELHIVERY_PRODUCTION_WRITES: 'false' });
    expect(shippingProvider).toMatchObject({ name: 'mock', environment: 'mock', courierName: 'Delhivery' });
  });

  it('treat blanks (as docker-compose passes them) as unset', async () => {
    const { env } = await load({ DELHIVERY_ENV: '', DELHIVERY_API_TOKEN: '', DELHIVERY_PRODUCTION_WRITES: '' });
    expect(env).toMatchObject({ DELHIVERY_ENV: 'staging', DELHIVERY_API_TOKEN: undefined, DELHIVERY_PRODUCTION_WRITES: 'false' });
  });

  it('use Delhivery staging when switched on with a token', async () => {
    const { shippingProvider } = await load({ SHIPPING_PROVIDER: 'delhivery', DELHIVERY_API_TOKEN: 'tok' });
    expect(shippingProvider).toMatchObject({ name: 'delhivery', environment: 'staging' });
  });

  it('refuse to start Delhivery without a token', async () => {
    await expect(load({ SHIPPING_PROVIDER: 'delhivery' })).rejects.toThrow(/DELHIVERY_API_TOKEN/);
  });

  it('keep live Delhivery read-only unless production writes are switched on', async () => {
    const { shippingProvider } = await load({ SHIPPING_PROVIDER: 'delhivery', DELHIVERY_API_TOKEN: 'tok', DELHIVERY_ENV: 'production' });
    expect(shippingProvider.environment).toBe('production');
    await expect(shippingProvider.cancelShipment('1490810000001')).rejects.toMatchObject({ code: 'PRODUCTION_WRITES_DISABLED' });
    // Anything but exactly 'true' is refused at boot rather than read as "on".
    await expect(
      load({ SHIPPING_PROVIDER: 'delhivery', DELHIVERY_API_TOKEN: 'tok', DELHIVERY_ENV: 'production', DELHIVERY_PRODUCTION_WRITES: 'yes' }),
    ).rejects.toThrow();
  });
});
