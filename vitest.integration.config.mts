import { defineConfig } from 'vitest/config';

/**
 * Integration tests: real Postgres, real Express app, real HTTP.
 *
 * Split from the unit config so `npm test` stays a sub-second feedback loop.
 * These need a database, so they get their own command and their own file
 * suffix (*.integration.test.ts).
 */
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.integration.test.ts'],
    environment: 'node',
    globalSetup: ['apps/api/src/test/globalSetup.ts'],
    setupFiles: ['apps/api/src/test/env.ts'],
    // One database, so files must not race each other over the fixture.
    fileParallelism: false,
    // Migrating a fresh database on the first run is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
