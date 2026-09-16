import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from './env';

/**
 * Creates and migrates a disposable database once per run.
 *
 * A separate database rather than transactions-per-test: the search path runs
 * raw SQL against generated columns and GIN indexes, so the schema under test
 * has to be the real migrated schema, not a subset. Dropping and recreating it
 * each run also means a half-finished previous run cannot leak state into the
 * next one.
 */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const testDbName = url.pathname.replace(/^\//, '');

  if (!/test/i.test(testDbName)) {
    throw new Error(
      `Refusing to run integration tests against "${testDbName}" — the database name must contain "test".`,
    );
  }

  // Connect to the maintenance database to (re)create the test one.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    // Terminate stragglers, or DROP DATABASE blocks.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await admin.query(`CREATE DATABASE "${testDbName}"`);
  } finally {
    await admin.end();
  }

  // The real migrations, so the tests exercise the schema that ships.
  const apiDir = path.resolve(__dirname, '../..');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
