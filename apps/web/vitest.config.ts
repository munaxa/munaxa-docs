import { defineConfig } from 'vitest/config';

/**
 * The web app's unit tests.
 *
 * Scoped to `.spec.ts` — not `.spec.tsx` — and that is the boundary rather than an oversight. What is
 * worth unit-testing here is the pure logic the screens are built on: reading a list's state out of a
 * URL, canonicalising it back, and deciding which fields a form actually changed. Those are functions
 * with answers. Rendering a grid is verified by the type checker and by using it; a test asserting that
 * a dialogue contains a button tests React, not this product.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    environment: 'node',
  },
});
