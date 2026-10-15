import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests: pure functions only, no database, no server.
 *
 * Kept fast enough to run on every save. Anything needing Postgres is named
 * *.integration.test.ts and excluded here — it has its own config and its own
 * command, because `.integration.test.ts` also ends in `.test.ts` and would
 * otherwise be picked up and fail for want of a database.
 *
 * The web app's client helpers (apps/web/lib) are tested here too, with a
 * stubbed browser: `@/` resolves as it does in Next, and TSX compiles with
 * the automatic runtime.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'apps/web/{lib,components}/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    environment: 'node',
  },
});
