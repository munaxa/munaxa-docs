import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * NestJS resolves constructor dependencies from `design:paramtypes`, which esbuild does not
 * emit. SWC does, so the API's tests are transformed with it rather than with vitest's
 * default pipeline.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/__tests__/**/*.spec.ts'],
    // Integration suites need a live PostgreSQL and are run by `pnpm test:integration`, not by
    // the default suite that CI runs on every push.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.spec.ts'],
    environment: 'node',
    coverage: { provider: 'v8', reporter: ['text', 'lcov'], reportsDirectory: 'coverage' },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
