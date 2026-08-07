import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The web app's tests, in two projects.
 *
 * **`logic`** (node) — the pure functions the screens are built on: reading a list's state out of a
 * URL, canonicalising it back, deciding which fields a form actually changed, and the stylesheet
 * checker's string handling. No DOM, so none is created.
 *
 * **`a11y`** (jsdom) — the accessibility suites, which are the reason `.tsx` is tested at all.
 * Phase 5.1 recorded that every accessibility claim in this product was a static reading of source,
 * and that one such reading had already been wrong: Phase 19 reported the skip link missing because
 * a `grep` cannot see a prop passed to `AppShell`. Only a rendered tree settles it.
 *
 * Rendering is still not used to assert that a dialogue contains a button — that tests React. It is
 * used to ask axe whether what a person receives is operable.
 *
 * Two projects rather than one with `environmentMatchGlobs`, which is deprecated, and because the
 * DOM setup file must not run in the node project: it defines `window.matchMedia`, and there is no
 * `window` there.
 */
const alias = {
  // A Next marker module that exists only to make the compiler refuse a client import. It has no
  // runtime, so under vitest it must resolve to something — the screens reach it transitively
  // through their server actions.
  'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)),
};

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'logic',
          environment: 'node',
          include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        resolve: { alias },
        test: {
          name: 'a11y',
          environment: 'jsdom',
          include: ['src/**/*.spec.tsx'],
          exclude: ['src/test/visual.spec.tsx'],
          setupFiles: ['src/test/setup.tsx'],
        },
      },
      {
        // Contrast and screenshots, in real Chromium. Separate because it reads the *built*
        // stylesheet, so it has to run after `build` — and `test` runs before it. `pnpm
        // test:visual` is the turbo task that orders them.
        extends: true,
        resolve: { alias },
        test: {
          name: 'browser',
          environment: 'node',
          include: ['src/test/visual.spec.tsx'],
          setupFiles: ['src/test/setup-ssr.tsx'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
