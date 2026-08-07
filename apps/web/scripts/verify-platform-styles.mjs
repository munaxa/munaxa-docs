#!/usr/bin/env node
/**
 * The regression guard for the defect Phase 19 found.
 *
 * `globals.css` points Tailwind's `@source` at `@munaxa/platform`'s compiled output, so that the
 * utility classes baked into the platform's own components are generated into this application's
 * stylesheet. Nothing else makes that happen: the platform ships components, not CSS.
 *
 * When that directive stops resolving — a dependency demoted to transitive, a package layout
 * change, a pnpm linking mode, a moved `dist/` — Tailwind silently scans nothing and emits a
 * stylesheet missing every class only the platform uses. Phase 19 measured that state: 136 of 249
 * sampled classes had no rule, including `bg-card`, `bg-primary` and `border-primary`. Every
 * gate stayed green. It is not a type error, not a lint error, not a test failure and not a build
 * failure — the build succeeds and emits a stylesheet that is 64% too small.
 *
 * So this check reads the *generated stylesheet*, which is the only artefact where the failure is
 * visible. Asserting anything about component source would restate what the source already says.
 *
 * It runs after `build`, against `.next/static/css/*.css`.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasRule, isUtility, splitClasses } from './platform-styles.mjs';

const WEB = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Named classes, used to make a failure legible — **not** as the check itself.
 *
 * The distinction was measured rather than assumed. With `@munaxa/platform` a direct dependency
 * but the `@source` path broken, the build emits 23.5 kB instead of 61.5 kB and 146 platform
 * classes have no rule — yet every name below still resolves, because a handful of utilities
 * reach the stylesheet by another route once the package is merely linked. A check that asserted
 * only these would have reported a healthy stylesheet that was missing 59% of itself.
 *
 * So the derived sweep is the guard, and these exist to name a symptom when it fires.
 */
const SENTINELS = [
  'bg-card',
  'bg-background',
  'bg-primary',
  'bg-muted',
  'border-primary',
  'border-border',
  'backdrop-blur-xs',
  'text-muted-foreground',
];

/**
 * Every class the platform's compiled components hand to Tailwind.
 *
 * @returns {string[]}
 */
function platformClasses() {
  const dist = join(WEB, 'node_modules/@munaxa/platform/dist');
  if (!existsSync(dist)) {
    fail(
      `@munaxa/platform is not resolvable from ${WEB}.`,
      '',
      'This is the Phase 19 defect itself: the package must be a *direct* dependency of',
      '@edms/web for pnpm to link it here, and globals.css’s `@source` to resolve.',
      'Declaring it transitively through @munaxa/ui is not enough under',
      'shamefully-hoist=false.',
    );
  }

  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  };
  walk(dist);

  /** @type {Set<string>} */
  const found = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/className:\s*"([^"]+)"/g)) {
      for (const name of splitClasses(match[1])) {
        if (isUtility(name)) found.add(name);
      }
    }
  }
  return [...found].sort();
}

/** @returns {string} */
function stylesheet() {
  const dir = join(WEB, '.next/static/css');
  if (!existsSync(dir)) {
    fail('No built stylesheet found.', '', 'Run `pnpm --filter @edms/web build` first.');
  }
  const files = readdirSync(dir).filter((name) => name.endsWith('.css'));
  if (files.length === 0) fail(`No .css file in ${dir}.`);
  return files.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
}

/**
 * @param {...string} lines
 * @returns {never}
 */
function fail(...lines) {
  console.error('\n  Platform stylesheet verification FAILED\n');
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}

const css = stylesheet();
const classes = platformClasses();
if (classes.length < 100) {
  fail(
    `Only ${String(classes.length)} classes were found in @munaxa/platform's compiled output.`,
    '',
    'That is too few to be a real scan — the package layout has probably changed, and this',
    'check would pass vacuously. Update the extraction in this script rather than the bound.',
  );
}

const missing = classes.filter((name) => !hasRule(css, name));
if (missing.length > 0) {
  const hitSentinels = SENTINELS.filter((name) => missing.includes(name));
  fail(
    `${String(missing.length)} of ${String(classes.length)} platform utility classes have no rule in the built stylesheet.`,
    '',
    ...(hitSentinels.length > 0
      ? [
          'Among them are the semantic surfaces and brand colours — the design system is',
          'shipping without its colour:',
          '',
          ...hitSentinels.map((name) => `  ✗ ${name}`),
          '',
          'The rest:',
          '',
        ]
      : []),
    ...missing
      .filter((name) => !hitSentinels.includes(name))
      .slice(0, 40)
      .map((name) => `  ✗ ${name}`),
    ...(missing.length - hitSentinels.length > 40
      ? [`  … and ${String(missing.length - hitSentinels.length - 40)} more`]
      : []),
    '',
    'Tailwind is not scanning @munaxa/platform. Platform components will render with their',
    'structure and none of their styling. Check that @munaxa/platform is a direct dependency',
    'of @edms/web and that the `@source` path in src/app/globals.css resolves to its dist/.',
  );
}

// `process.stdout` rather than `console.log`: this is the command's result on success, and the
// lint rule that reserves `console` for warnings and errors is right to.
process.stdout.write(
  `Platform stylesheet verified — ${String(classes.length)} platform utility classes, all generated (${String(Math.round(css.length / 1024))} kB).\n`,
);
