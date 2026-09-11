import { defineConfig } from 'vitest/config';

/**
 * The suite talks to one real Postgres database and mutates rows in it, so the
 * files must not run in parallel workers. There is only one file today; the
 * setting is here so a second one cannot quietly corrupt the first.
 *
 * Environment comes from `.env` via `dotenv/config` in src/config/env.ts — the
 * same path the app uses in development, so a config error fails the suite the
 * same way it would fail boot.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    // Bcrypt at 12 rounds dominates: each login is ~250ms and the suite logs in
    // a dozen times before it asserts anything.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
