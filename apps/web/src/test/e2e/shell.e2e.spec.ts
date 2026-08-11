import { existsSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { en } from '@edms/i18n';

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

const WIDTHS = [1440, 1280, 1024, 768, 640, 390] as const;

/**
 * Contrast failures that belong to `@munaxa/platform`, matched by the class that causes them.
 *
 * One entry, and it is the `Badge` palette issue recorded since Phase 5.2: `text-primary-strong` on
 * the component's own `bg-primary/15` tint measures 4.31:1 against the 4.5:1 AA asks for. The class
 * is the component's own, with no prop by which a host application can change it, so the only
 * product-side remedies would be overriding platform styling or hardcoding a colour — the two
 * things `ARCHITECTURE.md` forbids.
 *
 * **`text-muted-foreground` was here after Phase 7.8 and has been removed — the gap was not real.**
 * See `settleColours` below: the 3.57:1 that justified it was a colour transition measured
 * mid-flight. With the transition settled the rail measures 6.89:1 in dark, and a tolerance for a
 * defect that does not exist is worse than no tolerance at all, because it silently excuses every
 * future regression that happens to use the same class.
 *
 * The discipline is `visual.spec.tsx`'s, since Phase 5.2: the known gap is named, and **every
 * violation that is not this one fails the build**.
 */
const KNOWN_PLATFORM_CONTRAST: readonly string[] = ['text-primary-strong'];

/**
 * The application shell, measured across the four reference screens — Phase 7.8.
 *
 * Library, Dashboard, Document Record and Search each passed their own running-application
 * verification. This suite asks the question none of them could: does the *frame* around them make
 * them feel like one product. It is deliberately cross-screen — every assertion runs on all four
 * routes, because a shell defect that shows on only one screen is a screen defect.
 *
 * ## Why it navigates as little as it does
 *
 * One authenticated session, and the smallest number of page loads that still covers the matrix.
 * The API's default rate limit is 300 requests per 60 seconds and a dashboard render alone costs
 * about a dozen, so the first version of this suite — which re-navigated for every width and every
 * theme — drove the product into a genuine `RATE_LIMITED` error boundary at 390px and reported it
 * as a missing navigation control. The product was right and the suite was wrong. Each test now
 * loads a route **once** and resizes or re-themes the page it already has, which is the pattern
 * Phase 7.1C established for exactly this reason.
 */
describe('the application shell in the running product', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let routes: readonly { readonly name: string; readonly path: string }[] = [];

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
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();

    routes = [
      { name: 'dashboard', path: '/' },
      { name: 'library', path: '/documents' },
      { name: 'search', path: `/search?q=${encodeURIComponent(fixture.documentNumber)}` },
      { name: 'record', path: `/documents/${fixture.documentId}` },
    ];
  }, 240_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  /**
   * The page canvas and live axe, in one pass per theme.
   *
   * **The canvas** is the defect Phase 7.7B measured on Search and deferred as product-wide.
   * `AppShell` renders `<div class="flex min-h-screen">` and paints nothing — its own docstring
   * says "The shell owns *structure* and nothing else" — and no theme stylesheet carries a `body`
   * rule. So nothing was painting the document and the browser's own canvas showed through: white,
   * coincidentally right in light and plainly wrong behind a dark shell.
   *
   * This asserts the canvas is *painted*, not that it is any particular colour. A test naming
   * `#0a0f1a` would be this repository restating a platform token, which is what the architecture
   * forbids; the value is logged instead, so the report can quote it.
   *
   * **axe** runs on the same page load, with `color-contrast` left on, in both themes. `incomplete`
   * is logged as well as `violations` because axe returns "needs review" rather than a violation
   * when it cannot resolve an element's effective background — a `color-mix` or a semi-transparent
   * surface, both of which this theme uses — so it is a count to watch rather than a pass mark.
   *
   * Colours are settled before axe runs, for the reason `settleColours` documents: measuring during
   * a `transition-colors` reports interpolated values, and Phase 7.8 turned one such reading into a
   * platform finding that was not real.
   */
  it.each(['light', 'dark'] as const)('paints the canvas and passes axe in %s', async (theme) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const unrecorded: Record<string, string[]> = {};
    for (const route of routes) {
      await page.goto(`${WEB_URL}${route.path}`, { waitUntil: 'networkidle' });
      await setTheme(page, theme);
      await settleColours(page);

      const canvas = await page.evaluate(() => ({
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        dark: document.documentElement.classList.contains('dark'),
      }));
      console.log(`[canvas ${theme} ${route.name}]`, JSON.stringify(canvas));

      expect(canvas.dark, `the ${theme} toggle did not take effect on ${route.name}`).toBe(
        theme === 'dark',
      );
      expect(
        canvas.body,
        `the page canvas is unpainted on ${route.name} in ${theme} — the browser default shows through`,
      ).not.toBe('rgba(0, 0, 0, 0)');
      expect(canvas.bodyColor, `no document text colour on ${route.name}`).not.toBe('');

      await page.addScriptTag({ path: AXE_PATH });
      const audited = await page.evaluate(async () => {
        const results = await (
          window as unknown as {
            axe: {
              run: (ctx: Document) => Promise<{ violations: unknown[]; incomplete: unknown[] }>;
            };
          }
        ).axe.run(document);
        return {
          serious: (
            results.violations as {
              id: string;
              impact: string;
              nodes: { target: string[]; html: string }[];
            }[]
          )
            .filter(
              (violation) => violation.impact === 'critical' || violation.impact === 'serious',
            )
            .flatMap((violation) =>
              violation.nodes.map((node) => ({
                // The target as well as the rule: a bare count sends the next reader back to the
                // browser to find out *what* failed, which is the cost this line removes.
                label: `${violation.impact}: ${violation.id} ${node.target.join(' ')}`,
                html: node.html,
              })),
            ),
          contrastNeedsReview: (results.incomplete as { id: string; nodes: unknown[] }[])
            .filter((entry) => entry.id === 'color-contrast')
            .reduce((total, entry) => total + entry.nodes.length, 0),
        };
      });

      const tolerated = audited.serious.filter((node) =>
        KNOWN_PLATFORM_CONTRAST.some((known) => node.html.includes(known)),
      );
      unrecorded[route.name] = audited.serious
        .filter((node) => !tolerated.includes(node))
        .map((node) => node.label);
      console.log(
        `[axe ${theme} ${route.name}]`,
        JSON.stringify({
          unrecorded: unrecorded[route.name],
          tolerated: tolerated.length,
          contrastNeedsReview: audited.contrastNeedsReview,
        }),
      );

      if (theme === 'dark') {
        await page.screenshot({
          path: `src/test/__e2e_screenshots__/shell-dark-${route.name}.png`,
          fullPage: false,
        });
      }
    }

    expect(unrecorded).toStrictEqual({ dashboard: [], library: [], search: [], record: [] });
    await setTheme(page, 'light');
  });

  /**
   * The navigation rail's contrast, measured rather than recalled.
   *
   * An earlier audit recorded `SidebarNav` at ≈2.78:1. That number is not carried forward: the
   * ratio is computed here from the running application against each link's *effective* background
   * — walking up past transparent ancestors, which is what a reader's eye does and what a naive
   * `getComputedStyle` on the element alone gets wrong. (The first run of this suite produced 2.87
   * in light, but it ran against the unpainted canvas and with earlier tests aborted mid-way; the
   * numbers below are from a clean run and supersede it.)
   *
   * 4.5:1 is WCAG AA for text this size. The active item and the resting items are measured
   * separately because they are different token pairs and regress independently.
   */
  it.each(['light', 'dark'] as const)('keeps the navigation rail readable in %s', async (theme) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(WEB_URL, { waitUntil: 'networkidle' });
    await setTheme(page, theme);
    await settleColours(page);

    const measured = await page.evaluate(() => {
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
      const parse = (value: string): number[] =>
        (/rgba?\(([^)]+)\)/.exec(value)?.[1] ?? '0,0,0')
          .split(',')
          .map((part) => Number.parseFloat(part.trim()));
      const opaqueBackground = (from: Element): number[] => {
        let node: Element | null = from;
        while (node !== null) {
          const parsed = parse(getComputedStyle(node).backgroundColor);
          if ((parsed[3] ?? 1) > 0) {
            return parsed;
          }
          node = node.parentElement;
        }
        return [255, 255, 255];
      };
      const ratio = (element: Element): number => {
        const text = luminance(parse(getComputedStyle(element).color));
        const back = luminance(opaqueBackground(element));
        const [light, dark] = text > back ? [text, back] : [back, text];
        return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
      };

      const links = [...document.querySelectorAll('nav a')].filter(
        (link) => link.getBoundingClientRect().width > 0,
      );
      const active = links.find((link) => link.getAttribute('aria-current') !== null) ?? null;
      const resting = links.filter((link) => link !== active);
      const headings = [...document.querySelectorAll('nav')]
        .flatMap((nav) => [...nav.querySelectorAll('div, span, h2, h3, p')])
        .filter(
          (node) =>
            node.children.length === 0 &&
            (node.textContent ?? '').trim().length > 0 &&
            node.closest('a') === null &&
            node.getBoundingClientRect().width > 0,
        );

      const worst: Element | undefined = resting.reduce<Element | undefined>(
        (lowest, link) => (lowest === undefined || ratio(link) < ratio(lowest) ? link : lowest),
        undefined,
      );

      return {
        links: links.length,
        active: active === null ? null : Number(ratio(active).toFixed(2)),
        restingWorst: Number(Math.min(...resting.map(ratio)).toFixed(2)),
        headingWorst:
          headings.length === 0 ? null : Number(Math.min(...headings.map(ratio)).toFixed(2)),
        // Which element, and which pair — a ratio on its own cannot tell a token problem from a
        // composition one, and Phase 7.9 needed to know which of the two this is.
        worst:
          worst === undefined
            ? null
            : {
                text: (worst.textContent ?? '').trim().slice(0, 24),
                color: getComputedStyle(worst).color,
                background: `rgb(${opaqueBackground(worst).slice(0, 3).join(', ')})`,
                // The token as well as the resolved colour: a ratio alone cannot tell a token
                // problem from a composition one, and Phase 7.9 needed exactly that distinction.
                token: getComputedStyle(worst).getPropertyValue('--muted-foreground').trim(),
              },
      };
    });

    console.log(`[rail ${theme}]`, JSON.stringify(measured));

    expect(measured.links, 'no navigation links were found to measure').toBeGreaterThan(5);
    expect(measured.active, `the current rail item is below AA in ${theme}`).toBeGreaterThanOrEqual(
      4.5,
    );

    /*
     * The resting items — AA in **both** themes, which is the correction Phase 7.9 exists to make.
     *
     * Measured with transitions settled: **4.97:1 light** (`#667085` on `#ffffff`) and **6.89:1
     * dark** (`#98a2b3` on `#101828`), both matching the palette exactly. Phase 7.8's 3.57:1 was
     * the light colour caught part-way through `transition-colors`, and the ≈2.78:1 before it was
     * never reproducible either. There is no `SidebarNav` contrast gap.
     */
    expect(
      measured.restingWorst,
      `a resting rail item is below AA in ${theme}`,
    ).toBeGreaterThanOrEqual(4.5);

    if (measured.headingWorst !== null) {
      // The rail's group titles are `text-muted-foreground/70` — a fade *of* the muted token, so
      // they are dimmer again than the items above. They are small uppercase labels rather than
      // body text, so they are logged and held to the 3:1 large-text threshold.
      expect(
        measured.headingWorst,
        `a rail section heading is below 3:1 in ${theme}`,
      ).toBeGreaterThanOrEqual(3);
    }

    await setTheme(page, 'light');
  });

  /**
   * The account control, traced rather than judged.
   *
   * Phase 7.8 measured this chip rendering **two UUIDs** and an avatar initial taken from the first
   * character of one of them, and established that the web application had nothing else to render:
   * `/auth/me` returned identifiers only. Phase 7.9 found the information had been in the domain all
   * along — `User.display_name` and `User.email` since Phase 1 — and added it to the response.
   *
   * So this asserts the person, not the identifier: the signed-in user's own name and address, as
   * the fixture created them. It fails if the API stops carrying the fields, if the layout stops
   * passing them, or if anybody reintroduces a name derived from the UUID.
   */
  it('shows the signed-in person in the account control', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(WEB_URL, { waitUntil: 'networkidle' });

    const account = page.getByRole('button', { name: en.nav.account });
    await account.waitFor({ state: 'visible' });
    const text = (await account.innerText()).trim();
    console.log('[account chip]', JSON.stringify(text));

    expect(text).toContain(fixture.signer.name);
    expect(text).toContain(fixture.signer.email);
    expect(text, 'the account chip is still rendering a raw identifier').not.toContain(
      fixture.signer.id,
    );
    expect(text, 'the account chip is still rendering the tenant identifier').not.toContain(
      fixture.tenantId,
    );
  });

  /**
   * The shell at six widths on every reference screen — one page load per screen.
   *
   * Resizing does not re-fetch, which is the whole reason the loops are this way round: twenty-four
   * navigations tripped the API's rate limiter and produced an error boundary that looked like a
   * missing navigation control.
   */
  it('contains the shell at every width on every reference screen', async () => {
    for (const route of routes) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${WEB_URL}${route.path}`, { waitUntil: 'networkidle' });

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(() => document.readyState === 'complete');

        const measured = await page.evaluate(() => {
          const visible = (element: Element): boolean =>
            element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
          return {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            // The way into the navigation differs by width — a rail above `md`, a drawer trigger
            // below it — and "there is a way" is the property that matters rather than which.
            ways: [...document.querySelectorAll('nav a, button[aria-haspopup="dialog"]')].filter(
              visible,
            ).length,
          };
        });
        console.log(`[shell ${route.name} ${String(width)}]`, JSON.stringify(measured));

        expect(
          measured.scrollWidth,
          `${route.name} overflows horizontally at ${String(width)}px`,
        ).toBeLessThanOrEqual(measured.clientWidth);
        expect(
          measured.ways,
          `no way to reach navigation on ${route.name} at ${String(width)}px`,
        ).toBeGreaterThan(0);

        if (route.name === 'dashboard') {
          await page.screenshot({
            path: `src/test/__e2e_screenshots__/shell-${String(width)}.png`,
            fullPage: false,
          });
        }
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
  });

  /**
   * Arabic, through the real `edms_locale` cookie — one page load per screen, resized between the
   * two widths. Nothing is faked with CSS and no Arabic string is introduced.
   */
  it('renders the shell in Arabic at 1280 and 390', async () => {
    await context.addCookies([{ name: 'edms_locale', value: 'ar', url: WEB_URL }]);

    for (const route of routes) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${WEB_URL}${route.path}`, { waitUntil: 'networkidle' });

      expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
      expect(await page.locator('html').getAttribute('lang')).toBe('ar');

      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(() => document.readyState === 'complete');

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(
          overflow.scrollWidth,
          `Arabic ${route.name} overflows at ${String(width)}px`,
        ).toBeLessThanOrEqual(overflow.clientWidth);

        if (route.name === 'dashboard') {
          await page.screenshot({
            path: `src/test/__e2e_screenshots__/shell-ar-${String(width)}.png`,
            fullPage: false,
          });
        }
      }
    }

    await context.clearCookies({ name: 'edms_locale' });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  /**
   * The shell operated from the keyboard.
   *
   * The skip link is the first stop by design, and the walk has to reach the rail, the theme
   * control and the account control. No count of presses is asserted — that would test DOM order
   * rather than whether a person can work.
   */
  it('is operable from the keyboard', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(WEB_URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      document.body.focus();
    });

    const reached = { skip: false, rail: false, theme: false, account: false, outlined: false };
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) {
          return null;
        }
        const style = getComputedStyle(active);
        return {
          text: (active.textContent ?? '').trim(),
          label: active.getAttribute('aria-label') ?? '',
          inNav: active.closest('nav') !== null,
          href: active.getAttribute('href') ?? '',
          outlined: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
        };
      });
      if (stop === null) {
        continue;
      }
      if (stop.outlined) {
        reached.outlined = true;
      }
      if (stop.href.startsWith('#')) {
        reached.skip = true;
      }
      if (stop.inNav && stop.href !== '') {
        reached.rail = true;
      }
      const name = `${stop.label} ${stop.text}`;
      if (name.includes(en.nav.darkMode) || name.includes(en.nav.lightMode)) {
        reached.theme = true;
      }
      if (name.includes(en.nav.account)) {
        reached.account = true;
      }
      if (reached.skip && reached.rail && reached.theme && reached.account) {
        break;
      }
    }

    expect(reached).toStrictEqual({
      skip: true,
      rail: true,
      theme: true,
      account: true,
      outlined: true,
    });
  });
});

/**
 * Wait for colour transitions to finish before measuring one — Phase 7.9, and the correction it
 * exists to make.
 *
 * `SidebarNav` puts `transition-colors` on every rail item. Phase 7.8 measured the rail immediately
 * after clicking the theme control and recorded **3.57:1 in dark**, wrote it up as a platform token
 * gap, and guarded it. It was a **transition artefact**: `getComputedStyle().color` returns the
 * interpolated value while a transition is in flight, so the reading was the *light* colour part-way
 * to the dark one. The evidence that settled it is in this file's diagnostics — the element's own
 * `--muted-foreground` read `#98a2b3` (dark), a freshly-created probe with the same class in the
 * same parent computed `#98a2b3`, and only the transitioning anchor still reported `#667085`.
 *
 * Two samples that agree, rather than a fixed sleep: a sleep is a guess about a duration the
 * platform is free to change.
 */
async function settleColours(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const sample = (): Promise<string> =>
          page.evaluate(() =>
            [...document.querySelectorAll('nav a')]
              .map((link) => getComputedStyle(link).color)
              .join('|'),
          );
        const first = await sample();
        await page.waitForTimeout(120);
        return first === (await sample()) ? 'stable' : 'moving';
      },
      { timeout: 10_000, message: 'the rail never stopped animating its colours' },
    )
    .toBe('stable');
}

/**
 * Switch the theme the way a person does.
 *
 * The top bar's control is a single button whose label names the theme it will switch *to*, so it
 * is clicked only when the document is not already in the wanted state — clicking blindly toggles
 * away from it on the second call. Nothing sets `.dark` directly and no CSS is injected.
 */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  /*
   * Wait for the control to know which theme it is in before reading or clicking.
   *
   * `ThemeToggle`'s label is `nav.appearance` until its effect has run — deliberately, so the
   * server's markup and the first client render agree — and only then becomes "Light" or "Dark".
   * Clicking by name before hydration finishes waits thirty seconds for a button that does not
   * exist yet, which is what the first run of this suite did on the record screen, where hydration
   * is slowest.
   */
  await page.waitForFunction(
    (labels) =>
      [...document.querySelectorAll('button[aria-label]')].some((button) =>
        labels.includes(button.getAttribute('aria-label') ?? ''),
      ),
    [en.nav.lightMode, en.nav.darkMode] as readonly string[],
  );

  const already = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if (already === (theme === 'dark')) {
    return;
  }
  await page
    .getByRole('button', {
      name: theme === 'dark' ? en.nav.darkMode : en.nav.lightMode,
      exact: true,
    })
    .click();
  await page.waitForFunction(
    (wantDark) => document.documentElement.classList.contains('dark') === wantDark,
    theme === 'dark',
  );
}
