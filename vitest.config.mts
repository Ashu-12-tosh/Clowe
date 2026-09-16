import { defineConfig } from 'vitest/config';

/**
 * Unit tests: pure functions only, no database, no server.
 *
 * Kept fast enough to run on every save. Anything needing Postgres is named
 * *.integration.test.ts and excluded here — it has its own config and its own
 * command, because `.integration.test.ts` also ends in `.test.ts` and would
 * otherwise be picked up and fail for want of a database.
 */
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    environment: 'node',
  },
});
