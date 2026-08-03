import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The integration suite: the real classes against a real PostgreSQL.
 *
 * Kept separate from the default suite because it needs infrastructure, and a test that cannot
 * run without a database has no business failing a lint-and-typecheck pipeline. Run it with
 * `pnpm test:integration` against the compose stack, after migrations and post-migration SQL.
 *
 * It exists because two defects in Phase 1 were invisible to unit tests: a revocation rolled
 * back by the exception that reported it, and row-level security applying to the table owner.
 * Both are properties of the database, and only the database can be asked about them.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    environment: 'node',
    // Real scrypt derivations and real transactions; the default 5s is not enough.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One database, shared state: these must not race each other.
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
