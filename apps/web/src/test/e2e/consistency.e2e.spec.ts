import { existsSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { en } from '@edms/i18n';

/** The catalogue's own top-level namespaces — the only prefixes a leaked key can begin with. */
const CATALOGUE_ROOTS = new Set(Object.keys(en));

import {
  type Fixture,
  type Servers,
  WEB_URL,
  cleanUpFixtures,
  seedFixture,
  signInAndCapture,
  startServers,
  stopServers,
} from './servers';

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const AXE_PATH = require.resolve('axe-core/axe.min.js');

/** The `Badge` palette issue, recorded since Phase 5.2 and the only tolerated contrast failure. */
const KNOWN_PLATFORM_CONTRAST = 'text-primary-strong';

/**
 * The findings this audit made, named so the suite guards everything else.
 *
 * Phase 8 is an audit: its output is a roadmap, not a refactor. A suite that failed on purpose
 * would block every future commit to make a point a document makes better — but a suite that
 * quietly widened its assertions until they passed would be worse. So each finding is listed here
 * with its report section, and **anything not listed fails**. A later phase deletes an entry when
 * it fixes the screen, which is how the finding stops being tolerated.
 */
const RECORDED_FINDINGS = {
  /** §6.1 — `RecentScreen` returns a bare `EmptyState`, outside `WorkspacePage`, when the list is empty. */
  noPageHeading: ['recent'],
  /** §6.2 — the delegations table overflows the viewport at 390px. */
  overflows: ['delegations'],
} as const;

/**
 * §6.3 — axe reports six serious `color-contrast` nodes on `/admin/users` and on no other sampled
 * route. The selector matches the platform navigation's group title
 * (`font-mono text-[10px] uppercase … text-muted-foreground/70` — a *fade of* the muted token, so
 * dimmer again than the rail items that measure 4.97:1 and 6.89:1).
 *
 * Recorded as **B — probable, one measurement short**: why the same class does not fire on
 * `/audit`, which renders the same rail, is not established, and Phase 7.9's lesson is that an
 * unexplained contrast number is usually the measurement rather than the product. The pairs are
 * logged beside the violation so the next phase starts from colours instead of counts.
 */
const RECORDED_AXE: Readonly<Record<string, readonly string[]>> = {
  '/admin/users': [
    'serious: color-contrast .gap-1.flex-col:nth-child(1) > .pb-1.font-mono.uppercase',
    'serious: color-contrast .gap-1.flex-col:nth-child(2) > .pb-1.font-mono.uppercase',
    'serious: color-contrast .gap-1.flex-col:nth-child(3) > .pb-1.font-mono.uppercase',
    'serious: color-contrast .gap-1.flex-col:nth-child(4) > .pb-1.font-mono.uppercase',
    'serious: color-contrast .gap-1.flex-col:nth-child(5) > .pb-1.font-mono.uppercase',
    'serious: color-contrast .gap-1.flex-col:nth-child(6) > .pb-1.font-mono.uppercase',
  ],
};

/**
 * The screens the four verified ones are *not* — Phase 8.
 *
 * Dashboard, Library, Search and Document Record each have their own running-application suite.
 * Nothing had ever driven the other twelve destinations in a browser, so every statement about them
 * was a source reading. This suite exists to replace those readings with measurements, and it is
 * deliberately shallow and wide: one page load per route, the handful of properties that are true of
 * every screen in a coherent product, and the grammar measured rather than inferred.
 *
 * It asserts only what already holds. Phase 8 is an audit — findings go in the report and become
 * later phases' work, and a suite that failed on purpose would block every future commit to make a
 * point that a document makes better.
 */
const ROUTES = [
  { name: 'approvals', path: '/approvals' },
  { name: 'audit', path: '/audit' },
  { name: 'delegations', path: '/delegations' },
  { name: 'notifications', path: '/notifications' },
  { name: 'recycle-bin', path: '/recycle-bin' },
  { name: 'reports', path: '/reports' },
  { name: 'recent', path: '/documents/recent' },
  { name: 'admin', path: '/admin' },
  { name: 'admin-users', path: '/admin/users' },
  { name: 'admin-document-types', path: '/admin/document-types' },
  { name: 'admin-libraries', path: '/admin/libraries' },
  { name: 'admin-settings', path: '/admin/settings' },
] as const;

interface Measured {
  readonly reachable: boolean;
  readonly forbidden: boolean;
  readonly h1: string | null;
  readonly h1Count: number;
  readonly pageFrame: { readonly paddingTop: string; readonly maxWidth: string } | null;
  readonly rawKeys: string[];
  readonly overflow1280: boolean;
  readonly overflow390: boolean;
}

describe('platform grammar across the non-reference screens', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const measured = new Map<string, Measured>();

  beforeAll(async () => {
    fixture = seedFixture();
    servers = await startServers(fixture);
    browser = await chromium.launch(
      existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {},
    );
    const state = await signInAndCapture(
      browser,
      WEB_URL,
      fixture.signer.email,
      fixture.password,
      fixture.slug,
    );
    context = await browser.newContext({
      storageState: state,
      viewport: { width: 1280, height: 900 },
    });
    page = await context.newPage();

    /*
     * One page load per route, then resize — the rate-limit lesson from Phase 7.8.
     *
     * Every measurement for a route is taken from the same load; nothing here re-navigates for a
     * second width or a second theme.
     */
    for (const route of ROUTES) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${WEB_URL}${route.path}`, { waitUntil: 'networkidle' });

      const body = await page.locator('body').innerText();
      const forbidden = body.includes(en.auth.forbidden);
      const reachable = !body.toLowerCase().includes('something went wrong');

      const shape = await page.evaluate(() => {
        const main = document.querySelector('main');
        const frame = main?.firstElementChild ?? null;
        const headings = [...document.querySelectorAll('main h1')];
        return {
          h1: headings[0]?.textContent?.trim() ?? null,
          h1Count: headings.length,
          pageFrame:
            frame === null
              ? null
              : {
                  paddingTop: getComputedStyle(frame).paddingTop,
                  maxWidth: getComputedStyle(frame).maxWidth,
                },
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });

      /*
       * A key that reached the screen instead of a sentence.
       *
       * `translate()` returns the key itself on a miss (`translate.ts`), so a leak looks exactly
       * like a dotted identifier. **Scoped to the catalogue's own top-level namespaces**, because
       * the first version of this check was not and reported six false positives on
       * `/admin/settings`: that screen renders each tenant setting's own key as its row title
       * (`title={setting.key}`), so `security.password.minimumLength` is data an operator is meant
       * to see, not a missing translation. A detector that cannot tell those apart manufactures
       * findings, which is the one thing an audit must not do.
       */
      const rawKeys = [...body.matchAll(/\b[a-z][a-zA-Z]*(?:\.[a-zA-Z]+){2,}\b/g)]
        .map((match) => match[0])
        .filter((candidate) => CATALOGUE_ROOTS.has(candidate.split('.')[0] ?? ''));

      await page.setViewportSize({ width: 390, height: 900 });
      await page.waitForFunction(() => document.readyState === 'complete');
      const overflow390 = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );

      measured.set(route.name, {
        reachable,
        forbidden,
        h1: shape.h1,
        h1Count: shape.h1Count,
        pageFrame: shape.pageFrame,
        rawKeys: [...new Set(rawKeys)],
        overflow1280: shape.overflow,
        overflow390,
      });
      console.log(`[grammar ${route.name}]`, JSON.stringify(measured.get(route.name)));
    }
  }, 300_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  it('reaches every route without an error boundary', () => {
    const broken = [...measured.entries()]
      .filter(([, value]) => !value.reachable)
      .map(([name]) => name);
    expect(broken).toStrictEqual([]);
  });

  /**
   * One `<h1>`, and it says something.
   *
   * The reference screens get theirs from `PageHeader`. A screen with none has no accessible page
   * title, and a screen with two has an ambiguous one — both are defects a reader meets before
   * anything visual.
   */
  it('gives every reachable screen exactly one page heading', () => {
    const wrong = [...measured.entries()]
      .filter(
        ([name, value]) =>
          value.reachable &&
          !value.forbidden &&
          value.h1Count !== 1 &&
          !RECORDED_FINDINGS.noPageHeading.includes(name as never),
      )
      .map(([name, value]) => `${name}: ${String(value.h1Count)}`);
    expect(wrong).toStrictEqual([]);
  });

  /** The recorded finding, asserted as a finding: it is still there, and it is still only there. */
  it('still shows the recorded page-heading gap, and only there', () => {
    const missing = [...measured.entries()]
      .filter(([, value]) => value.reachable && !value.forbidden && value.h1Count !== 1)
      .map(([name]) => name);
    expect(missing).toStrictEqual([...RECORDED_FINDINGS.noPageHeading]);
  });

  it('leaks no raw message key on any screen', () => {
    const leaking = [...measured.entries()]
      .filter(([, value]) => value.rawKeys.length > 0)
      .map(([name, value]) => `${name}: ${value.rawKeys.join(', ')}`);
    expect(leaking).toStrictEqual([]);
  });

  it('contains every screen horizontally at 1280 and 390', () => {
    const overflowing = [...measured.entries()]
      .filter(([name]) => !RECORDED_FINDINGS.overflows.includes(name as never))
      .filter(([, value]) => value.overflow1280 || value.overflow390)
      .map(
        ([name, value]) =>
          `${name}: ${value.overflow1280 ? '1280 ' : ''}${value.overflow390 ? '390' : ''}`,
      );
    expect(overflowing).toStrictEqual([]);
  });

  /**
   * axe on the widest sample this suite can afford, with contrast on.
   *
   * Four routes rather than twelve: a full sweep costs a page load each and the rate limiter is
   * real. These four are the ones the audit matrix marks as structurally different from the
   * reference screens, so they are where a violation is most likely.
   */
  it.each(['/audit', '/approvals', '/reports', '/admin/users'])(
    'has no unrecorded critical or serious axe violations on %s',
    async (path) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${WEB_URL}${path}`, { waitUntil: 'networkidle' });
      await page.addScriptTag({ path: AXE_PATH });

      const violations = await page.evaluate(async (known: string) => {
        const results = await (
          window as unknown as {
            axe: { run: (ctx: Document) => Promise<{ violations: unknown[] }> };
          }
        ).axe.run(document);
        return (
          results.violations as {
            id: string;
            impact: string;
            nodes: { target: string[]; html: string }[];
          }[]
        )
          .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
          .flatMap((violation) =>
            violation.nodes
              .filter((node) => !node.html.includes(known))
              .map((node) => `${violation.impact}: ${violation.id} ${node.target.join(' ')}`),
          );
      }, KNOWN_PLATFORM_CONTRAST);

      console.log(`[axe ${path}]`, JSON.stringify(violations));

      /*
       * When axe reports contrast, measure the pair rather than repeat the count.
       *
       * Twice in this sequence a contrast *number* was recorded without the pair behind it and was
       * wrong both times — once from a stale audit, once from a transition measured mid-flight. A
       * ratio is only a finding when the two colours that produced it are on the record.
       */
      if (violations.length > 0) {
        const pairs = await page.evaluate(() =>
          [...document.querySelectorAll('nav p, nav .font-mono')]
            .filter((node) => node.getBoundingClientRect().width > 0)
            .slice(0, 3)
            .map((node) => {
              let ancestor: Element | null = node;
              let background = 'rgba(0, 0, 0, 0)';
              while (ancestor !== null && background === 'rgba(0, 0, 0, 0)') {
                background = getComputedStyle(ancestor).backgroundColor;
                ancestor = ancestor.parentElement;
              }
              return {
                text: (node.textContent ?? '').trim().slice(0, 20),
                color: getComputedStyle(node).color,
                background,
                classes: node.className.slice(0, 120),
              };
            }),
        );
        console.log(`[contrast-pairs ${path}]`, JSON.stringify(pairs));
      }

      expect(violations).toStrictEqual(RECORDED_AXE[path] ?? []);
    },
  );
});
