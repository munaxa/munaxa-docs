import { render } from '@testing-library/react';
import axe, { type AxeResults, type Result, type RunOptions } from 'axe-core';
import type { ReactElement, ReactNode } from 'react';
import { expect } from 'vitest';

import { DEFAULT_LOCALE, type LocaleKey } from '@edms/i18n';

import { Providers } from '../app/providers';

/**
 * The accessibility harness.
 *
 * ## Why axe runs against a rendered tree rather than source
 *
 * Every accessibility claim Phase 19 and Phase 5.1 made was a static reading, and one of them was
 * wrong: Phase 19 reported `SkipLink` as absent because a `grep` for the symbol cannot see it being
 * passed as a prop and rendered by `AppShell`. A rendered tree cannot make that mistake — the link
 * is either in the document or it is not.
 *
 * ## What this cannot check, and why it is stated rather than hidden
 *
 * **Colour contrast.** jsdom has no layout engine and no cascade: every element computes to the
 * same default colours, so axe's `color-contrast` rule cannot run. It is disabled here explicitly
 * rather than left to report a meaningless pass — a rule that is silently inapplicable is worse
 * than one that is switched off on the record. Contrast is a property of the platform's palette
 * and is checked in a real browser by `scripts/verify-contrast.mjs`.
 *
 * **Anything requiring real geometry** — focus outlines, target sizes, scroll containers. Same
 * reason.
 */

/** Rules that cannot produce a meaningful verdict without layout, with the reason. */
const DISABLED_IN_JSDOM = {
  /** No cascade in jsdom: every element computes the same colours. Checked in a real browser. */
  'color-contrast': { enabled: false },
} as const;

/**
 * Rules axe ships **switched off**, which this product requires on.
 *
 * `duplicate-id` and `duplicate-id-active` were deprecated in axe-core 4.10 and default to
 * `enabled: false`; only `duplicate-id-aria` still runs. So a page with two `id="name"` inputs
 * passes a default axe run — verified against axe-core 4.13.0, not assumed.
 *
 * A duplicate id is a real defect here rather than a theoretical one: every field in this product
 * associates its label through `htmlFor`/`id`, so two elements sharing an id means a label pointing
 * at whichever the browser found first. Two instances of the same form on one screen is exactly how
 * it happens, which is why `FilterField` generates ids with `useId` instead of deriving them from
 * the field name.
 */
const REQUIRED_BUT_OFF_BY_DEFAULT = {
  'duplicate-id': { enabled: true },
  'duplicate-id-active': { enabled: true },
} as const;

export interface A11yOptions {
  /** Extra axe configuration — narrowing to a rule set, or raising an exception. */
  readonly rules?: RunOptions['rules'];
  readonly locale?: LocaleKey;
}

/**
 * Render inside the real provider stack.
 *
 * The providers are the real ones rather than doubles, because the translator is where an
 * accessible name comes from on almost every control in this product: a test that stubbed it
 * would assert that a button has the name `nav.account` and pass while the shipped one has none.
 */
export function renderWithProviders(
  ui: ReactNode,
  locale: LocaleKey = DEFAULT_LOCALE,
): HTMLElement {
  const { container } = render(
    <Providers session={{ userId: 'test-user', tenantId: 'test-tenant', locale }}>{ui}</Providers>,
  );
  return container;
}

/**
 * Assert that a rendered tree has no accessibility violations.
 *
 * Failures name the rule, its impact, the WCAG tags it maps to, and the offending markup, because
 * "1 violation" is a message somebody suppresses and "select element has no accessible name, here
 * is the element" is one they fix.
 */
export async function expectNoViolations(
  container: HTMLElement,
  options: A11yOptions = {},
): Promise<void> {
  const results: AxeResults = await axe.run(container, {
    rules: { ...DISABLED_IN_JSDOM, ...REQUIRED_BUT_OFF_BY_DEFAULT, ...options.rules },
  });

  if (results.violations.length > 0) {
    throw new Error(formatViolations(results.violations));
  }
  expect(results.violations).toStrictEqual([]);
}

/** Render and check in one step — the shape almost every test wants. */
export async function expectAccessible(ui: ReactElement, options: A11yOptions = {}): Promise<void> {
  const container = renderWithProviders(ui, options.locale);
  await expectNoViolations(container, options);
}

function formatViolations(violations: Result[]): string {
  const lines = [`${String(violations.length)} accessibility violation(s):`, ''];
  for (const violation of violations) {
    lines.push(
      `  ✗ [${violation.impact ?? 'unknown'}] ${violation.id} — ${violation.help}`,
      `    ${violation.tags.filter((tag) => tag.startsWith('wcag')).join(', ')}`,
      `    ${violation.helpUrl}`,
    );
    for (const node of violation.nodes.slice(0, 4)) {
      lines.push(`    at ${node.target.join(' ')}`, `      ${node.html.slice(0, 160)}`);
      if (node.failureSummary !== undefined) {
        for (const summary of node.failureSummary.split('\n')) {
          lines.push(`      ${summary}`);
        }
      }
    }
    if (violation.nodes.length > 4) {
      lines.push(`    … and ${String(violation.nodes.length - 4)} more element(s)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
