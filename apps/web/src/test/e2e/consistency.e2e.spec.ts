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
import { setTheme, settleColours } from './theme';

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const AXE_PATH = require.resolve('axe-core/axe.min.js');

/*
 * The `text-primary-strong` suppression is gone — Phase 8.3.
 *
 * From Phase 5.2 until now this suite filtered out every contrast violation whose node mentioned
 * `text-primary-strong`, on every route, calling it "the only tolerated contrast failure". It was
 * doing its job: axe had been reporting `Badge` as a serious violation the whole time, and the
 * filter is why three phases of green runs never surfaced it. A tolerated failure that outlives the
 * reason for tolerating it is indistinguishable from a defect nobody can see.
 *
 * `@munaxa/platform` 1.0.2 fixes the underlying token, so the exception has nothing left to excuse
 * and the assertion below is unconditional again.
 */

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
  /**
   * §6.1 — **fixed by Phase 8.1**, and the entry is deleted rather than kept.
   *
   * `RecentScreen` returned a bare `EmptyState` outside `WorkspacePage` when the list was empty, so
   * `/documents/recent` measured `h1Count: 0`. The empty branch now renders inside the frame. This
   * list is empty because that is what a fixed finding looks like: the assertion below is
   * unconditional again.
   */
  noPageHeading: [] as readonly string[],
  /**
   * §6.2 — **fixed by Phase 8.21**, and the entry is deleted rather than kept.
   *
   * The finding was recorded as "the delegations table overflows the viewport at 390px". The table
   * was never the cause: it scrolls inside its own container, as every table in the product does.
   * What overflowed was the page's action group — two `whitespace-nowrap` buttons in a `flex` that
   * could not wrap — by 112px at 320 and 42px at 390. `DelegationsScreen` wraps that group now.
   *
   * This list is empty because that is what a fixed finding looks like: the assertion below is
   * unconditional again, and it measures 320 as well.
   */
  overflows: [] as readonly string[],
} as const;

/**
 * §6.3 — **fixed by Phase 8.2**, and the entry is deleted rather than kept.
 *
 * axe reported six serious `color-contrast` nodes on `/admin/users` and on no other sampled route,
 * one per titled group in the admin section nav. The selector matched the platform navigation's
 * group title, which painted itself with `text-muted-foreground/70` — a *fade of* the muted token,
 * so dimmer again than the rail items beside it. `@munaxa/platform` 1.0.1 drops the `/70`; the
 * titles now use the same full-strength token as those items and the six nodes are gone.
 *
 * This map is empty because that is what a fixed finding looks like: the assertion below is
 * unconditional again, and any `color-contrast` node on any sampled route now fails the suite.
 */
const RECORDED_AXE: Readonly<Record<string, readonly string[]>> = {};

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

/**
 * Every statically-addressable route the application defines, for the axe sweep.
 *
 * Derived from `apps/web/src/app/**\/page.tsx` and kept beside `ROUTES` deliberately: the
 * consistency grammar above samples screens, while this asserts the accessibility floor on all of
 * them. Parameterised routes need a seeded id and are covered by their own suites.
 */
const AXE_ROUTES = [
  '/',
  '/approvals',
  '/audit',
  '/delegations',
  '/documents',
  '/documents/recent',
  '/notifications',
  '/recycle-bin',
  '/reports',
  '/search',
  '/admin',
  '/admin/api-clients',
  '/admin/approval-groups',
  '/admin/branches',
  '/admin/categories',
  '/admin/companies',
  '/admin/confidentiality',
  '/admin/departments',
  '/admin/document-types',
  '/admin/entities',
  '/admin/fields',
  '/admin/libraries',
  '/admin/notification-templates',
  '/admin/numbering',
  '/admin/permissions',
  '/admin/retention',
  '/admin/roles',
  '/admin/settings',
  '/admin/templates',
  '/admin/users',
  '/admin/webhooks',
  '/admin/workflows',
  '/admin/working-calendars',
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
  readonly overflow320: boolean;
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

      /*
       * 320 as well — Phase 8.21, and it costs a resize rather than a page load.
       *
       * Phase 8.17 made 320 the enforced width for the reference screens, on the grounds that WCAG
       * 2.1 AA 1.4.10 names 320 CSS px exactly. These twenty-nine screens kept a 390 floor for one
       * phase longer, and `/delegations` overflowed at both — by 42px at 390 and 112px at 320. The
       * narrower width is where a group that cannot wrap shows itself first, so measuring only the
       * wider one is measuring the easier half.
       */
      await page.setViewportSize({ width: 320, height: 900 });
      await page.waitForFunction(() => document.readyState === 'complete');
      const overflow320 = await page.evaluate(
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
        overflow320,
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

  /**
   * The recorded findings, asserted as findings: still there, and still only there.
   *
   * Phase 8.1 emptied `noPageHeading`, so this now asserts that **no** screen is missing its
   * heading — which is the same test doing the same job, and the reason the entry could be deleted
   * with confidence rather than merely crossed out.
   */
  it('shows the recorded page-heading gaps, and only those', () => {
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

  it('contains every screen horizontally at 1280, 390 and 320', () => {
    const overflowing = [...measured.entries()]
      .filter(([name]) => !RECORDED_FINDINGS.overflows.includes(name as never))
      .filter(([, value]) => value.overflow1280 || value.overflow390 || value.overflow320)
      .map(
        ([name, value]) =>
          `${name}: ${value.overflow1280 ? '1280 ' : ''}${value.overflow390 ? '390 ' : ''}${
            value.overflow320 ? '320' : ''
          }`,
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
  /**
   * The navigation group titles, measured in both themes — Phase 8.2.
   *
   * The one live instance is the **admin section nav**: `admin-shared/section-nav.tsx` passes six
   * titled groups to the platform's `SidebarNav`, while the main rail deliberately passes none
   * (`SECTION_HEADINGS_ACCESSIBLE = false`, Phase 7.1, for this very reason). That asymmetry is why
   * axe fires here and nowhere else.
   *
   * Colours are settled before measuring: Phase 7.9 established that reading during
   * `transition-colors` reports interpolated values and turned one such reading into a finding that
   * was not real. Two samples that agree, not a fixed sleep.
   *
   * These titles measured **2.79:1 light and 4.19:1 dark** while the platform faded the muted
   * token, both below the 4.5:1 AA asks of 10px text. Those numbers were recorded as floors rather
   * than asserted at AA only because the class belonged to `@munaxa/platform` and could not be
   * changed from this repository (Phase 8.2 §3). `@munaxa/platform` 1.0.1 drops the `/70`, so the
   * tolerance is over: the assertion below is now the plain AA threshold, in both themes.
   *
   * The ratio is composited through a canvas rather than parsed from the colour string — see the
   * comment inside, and the wrong numbers that made it necessary.
   */
  it.each(['light', 'dark'] as const)(
    'measures the navigation group titles in %s',
    async (theme) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${WEB_URL}/admin/users`, { waitUntil: 'networkidle' });
      await setTheme(page, theme);
      await settleColours(page);

      const measured = await page.evaluate(() => {
        /*
         * Composite through a canvas rather than parsing the colour string.
         *
         * `getComputedStyle().color` on a faded element comes back as `oklab(… / 0.7)`, and the
         * first version of this measurement fed that string to a probe element and read it back —
         * getting `oklab(…)` again, failing an `rgba()` regex, and silently falling back to black.
         * It reported 21:1 in light and 1.1:1 in dark, which is what black on white and black on
         * the dark canvas measure. Painting the background and then the foreground into a 1×1
         * canvas makes the browser do both the colour-space conversion and the alpha compositing,
         * and `getImageData` returns the pixel a reader actually sees.
         */
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d');

        const pixel = (background: string, foreground?: string): readonly number[] => {
          if (context === null) {
            return [0, 0, 0];
          }
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = background;
          context.fillRect(0, 0, 1, 1);
          if (foreground !== undefined) {
            context.fillStyle = foreground;
            context.fillRect(0, 0, 1, 1);
          }
          const data = context.getImageData(0, 0, 1, 1).data;
          return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
        };

        const luminance = (rgb: readonly number[]): number => {
          const channel = (value: number): number => {
            const c = value / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          };
          return (
            0.2126 * channel(rgb[0] ?? 0) +
            0.7152 * channel(rgb[1] ?? 0) +
            0.0722 * channel(rgb[2] ?? 0)
          );
        };

        /** The nearest ancestor that actually paints — what the eye sees behind the text. */
        const backgroundOf = (from: Element): string => {
          let node: Element | null = from;
          while (node !== null) {
            const colour = getComputedStyle(node).backgroundColor;
            if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') {
              return colour;
            }
            node = node.parentElement;
          }
          return 'rgb(255, 255, 255)';
        };

        return [...document.querySelectorAll('nav p')]
          .filter((node) => node.getBoundingClientRect().width > 0)
          .map((title) => {
            const background = backgroundOf(title);
            const back = luminance(pixel(background));
            const front = luminance(pixel(background, getComputedStyle(title).color));
            const [hi, lo] = front > back ? [front, back] : [back, front];
            return {
              text: (title.textContent ?? '').trim().slice(0, 24),
              ratio: Number((((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)).toFixed(2)),
            };
          });
      });

      console.log(`[group-titles ${theme}]`, JSON.stringify(measured));
      expect(measured.length, 'no titled navigation group was found to measure').toBeGreaterThan(0);

      const worst = Math.min(...measured.map((entry) => entry.ratio));
      expect(
        worst,
        `the navigation group titles fell below WCAG AA in ${theme}`,
        // WCAG AA for text this size, asserted directly now that the platform paints these titles
        // with the unfaded token. Measured in the running application with transitions settled.
      ).toBeGreaterThanOrEqual(4.5);

      await setTheme(page, 'light');
    },
  );

  /*
   * `/documents` joins the sample — Phase 8.3.
   *
   * The four routes above were chosen in Phase 8 as the screens furthest from the reference ones.
   * None of them renders a `Badge`, and `Badge` carried a serious `color-contrast` violation from
   * Phase 5.2 until Phase 8.3: axe reported it on `/documents` in the light theme, on a route this
   * suite never visited, so the suite stayed green for three phases while the violation shipped.
   * A sample is only as good as what it happens to include, and the fix for that is to include the
   * screen where the product's most reused status component actually appears.
   */
  /*
   * Every route, not a sample — Phase 8.15.
   *
   * The five routes below this comment were chosen carefully and the choice still cost something.
   * The application defines **forty** routes and this suite visited five, so a full-ruleset sweep
   * of the other thirty-five found what an unvisited screen always eventually holds:
   * `/admin/settings` shipped **twelve** `role="switch"` controls with no accessible name at all
   * (`button-name`, critical) and a paragraph painted in `--muted`, a *background* token, in both
   * themes. Neither had ever been looked at by anything.
   *
   * The lesson is the one Phase 8.3 already recorded here about `Badge` and `/documents`, and the
   * response then was to add one route. This adds all of them: a sweep is only as good as what it
   * happens to include, and the only sample that cannot be wrong is the whole set.
   *
   * Impact filter unchanged — critical and serious, exactly as before — so this widens *reach*
   * without quietly changing the standard. Moderate findings are recorded in the phase report;
   * `region` currently fires on every route and is deferred there with its cause.
   */
  it.each(AXE_ROUTES)(
    'has no unrecorded critical or serious axe violations on %s',
    async (path) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${WEB_URL}${path}`, { waitUntil: 'networkidle' });
      await page.addScriptTag({ path: AXE_PATH });

      const violations = await page.evaluate(async () => {
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
            violation.nodes.map(
              (node) => `${violation.impact}: ${violation.id} ${node.target.join(' ')}`,
            ),
          );
      });

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
