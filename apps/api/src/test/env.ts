import os from 'node:os';
import path from 'node:path';

/**
 * Environment for integration tests, applied before anything imports the app.
 *
 * Set here rather than read from a developer's .env for two reasons: the tests
 * must never touch the development database, and they must pass on a machine
 * that has no .env at all. Vitest runs setupFiles before the test module is
 * evaluated, and dotenv does not overwrite variables that are already set, so
 * these win over apps/api/.env.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://clowe:clowe_dev_password@localhost:5433/clowe_test?schema=public';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
// Run on UTC, as a server does. On a developer machine in India the server's
// own calendar is the Indian one, which would hide every bug the Indian-
// calendar helpers exist to prevent.
process.env.TZ = 'UTC';
// Long enough to satisfy the env schema; never used to sign anything real.
process.env.JWT_ACCESS_SECRET ??= 'integration-test-secret-not-a-real-key';
// Keep every provider on its mock so a test run cannot spend money or send SMS.
process.env.TRYON_PROVIDER = 'mock';
process.env.AI_PROVIDER = 'mock';
process.env.OTP_PROVIDER = 'mock';
process.env.KYC_PROVIDER = 'mock';
// Files the tests write go to scratch folders, never into the repo.
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'clowe-test-uploads');
process.env.PRIVATE_UPLOAD_DIR = path.join(os.tmpdir(), 'clowe-test-private-uploads');
