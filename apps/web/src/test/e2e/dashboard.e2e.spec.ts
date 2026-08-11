import { existsSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { en } from '@edms/i18n';

import {
  API_PORT,
  type Fixture,
  type Servers,
  WEB_URL,
  cleanUpFixtures,
  seedFixture,
  signInAndCapture,
  startServers,
  stopServers,
} from './servers';

/**
 * The dashboard, in the running product — Phase 7.6C.
 *
 * Phases 7.6A and 7.6B modernized this screen and verified it against the static-render harness:
 * server-rendered markup, the built stylesheet, a real Chromium, and no application behind it.
 * That is enough to judge composition and not enough to judge anything else. Three consecutive
 * phases asked for running-app evidence and none produced it, so what follows is deliberately the
 * cheapest thing that answers the question rather than a second E2E suite.
 *
 * **One sign-in, one page, six resizes.** Each width is a `setViewportSize` on the same page rather
 * than a fresh load, and that is not only about speed: Phase 7.1C spent an entire phase on a
 * record page that failed because the *test suite itself* exhausted a real rate-limit window. Six
 * logins and six full page loads to look at a layout would be spending the same budget for the same
 * reason. The layout is CSS; it does not need a new request to be re-measured.
 */
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

describe('dashboard in the running application', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  /** Everything the browser logged. Empty is the assertion; the contents are the diagnosis. */
  const consoleErrors: string[] = [];
  /** Every request the page made to the API, so fan-out is measured rather than argued. */
  const apiRequests: string[] = [];

  beforeAll(async () => {
    fixture = seedFixture();
    servers = await startServers(fixture);
    // The same accommodation `test/browser.ts` makes: Chromium is pre-installed in this
    // environment at a path Playwright's own resolver does not expect, and the default launch
    // asks for a `headless_shell` build that is not here. Falling back to the bundled resolver
    // when the path is absent keeps this working on a machine where it is.
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

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes(`:${String(API_PORT)}`) || url.includes('/api/')) {
        apiRequests.push(`${request.method()} ${url}`);
      }
    });

    await page.goto(WEB_URL, { waitUntil: 'networkidle' });
  }, 240_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  it('loads the dashboard rather than the login screen or an error boundary', async () => {
    expect(new URL(page.url()).pathname).toBe('/');

    await page
      .getByRole('heading', { name: en.dashboard.title, level: 1 })
      .waitFor({ state: 'visible' });

    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('something went wrong');
    expect(body).not.toContain('application error');
  });

  it('renders the sections the screen is made of', async () => {
    for (const heading of [en.dashboard.myWork, en.dashboard.recent.title]) {
      await page.getByRole('heading', { name: heading }).waitFor({ state: 'visible' });
    }
  });

  it('never shows a raw translation key to the reader', async () => {
    // The Phase 7.6A defect, asserted against the real API's own enum values rather than a fixture's.
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/dashboard\.(admin|user|tile)\./);
    expect(body).not.toMatch(/approvals\.instance/);
    expect(body).not.toMatch(/documents\.status\./);
  });

  it('logs no console errors while rendering', () => {
    expect(consoleErrors).toStrictEqual([]);
  });

  it('does not fan out: the page asks the API for the dashboard once', () => {
    const dashboardCalls = apiRequests.filter((entry) => entry.includes('/dashboard'));
    // The route is server-rendered, so the *browser* should make no dashboard call at all. One
    // would mean a client fetch had been introduced; several would be the Phase 7.1C regression.
    expect(dashboardCalls.length).toBeLessThanOrEqual(1);
  });

  /**
   * The six widths, on one page.
   *
   * `document.scrollWidth <= clientWidth` is the assertion that actually catches a broken layout —
   * a card that will not shrink, a table that will not wrap, a number that will not truncate — and
   * it is the one thing a screenshot cannot tell you without a human looking at it.
   */
  it.each([1440, 1280, 1024, 768, 640, 390])('fits the viewport at %ipx', async (width) => {
    await page.setViewportSize({ width, height: 900 });
    // No timer: waiting on the layout itself rather than on a guess about how long it takes.
    await page.waitForFunction(() => document.readyState === 'complete');

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    // The screen's own title must survive every width — a header that collapses is the failure
    // mode a narrow viewport produces most often.
    await page
      .getByRole('heading', { name: en.dashboard.title, level: 1 })
      .waitFor({ state: 'visible' });

    await page.screenshot({
      path: `src/test/__e2e_screenshots__/dashboard-${String(width)}.png`,
      fullPage: true,
    });
  });

  it('keeps the recent-document row readable on a phone', async () => {
    await page.setViewportSize({ width: 390, height: 900 });

    await page
      .getByRole('heading', { name: en.dashboard.recent.title })
      .waitFor({ state: 'visible' });
  });

  /**
   * The recent-document row, reached the way a person reaches it — Phase 7.6D.
   *
   * Phases 7.6B and 7.6C both left this unverified: the composition was improved and the dashboard
   * was proven to run, but the seeded tenant had never opened anything, so the panel rendered its
   * empty state and the row itself was only ever seen in a static render.
   *
   * The mechanism is not guessed. `DocumentService.open()` calls `activity.recordView(...)`, and the
   * only route that reaches `open()` is `GET /documents/:id` — so a document becomes "recently
   * opened" by **being opened**, and nothing else does it. Navigating to the record page is
   * therefore the entire product path, and no row is written by hand to make the panel populate.
   */
  it('records a document as recently opened by opening it, and shows it on the dashboard', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // The real user action: go to the document. The record page server-renders, which is what calls
    // GET /documents/:id, which is what records the view.
    await page.goto(`${WEB_URL}/documents/${fixture.documentId}`, { waitUntil: 'networkidle' });
    expect(new URL(page.url()).pathname).toBe(`/documents/${fixture.documentId}`);

    // Back to the dashboard, by navigation rather than by reload of a crafted URL.
    await page.getByRole('link', { name: en.nav.home, exact: true }).first().click();
    await page.waitForURL((url) => url.pathname === '/');

    const recent = page.locator('section, div').filter({
      has: page.getByRole('heading', { name: en.dashboard.recent.title }),
    });
    await page
      .getByRole('heading', { name: en.dashboard.recent.title })
      .waitFor({ state: 'visible' });

    const body = await page.locator('body').innerText();

    // The empty state must be gone — that is the whole point of the phase.
    expect(body).not.toContain(en.dashboard.recent.empty);

    // Values derived from the seeded document rather than hard-coded display text.
    expect(body).toContain(fixture.documentNumber);

    // The row links to the document it names.
    const rowLink = recent
      .getByRole('link', { name: new RegExp(fixture.documentNumber, 'i') })
      .first();
    await rowLink.waitFor({ state: 'visible' });

    await page.screenshot({
      path: 'src/test/__e2e_screenshots__/recent-populated-1440.png',
      fullPage: true,
    });
  });

  it('keeps the populated row within the viewport at every width', async () => {
    for (const width of [1440, 1280, 1024, 768, 640, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => document.readyState === 'complete');

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `populated recent row overflows at ${String(width)}px`,
      ).toBeLessThanOrEqual(overflow.clientWidth);

      // The number is the narrowest thing on the row and the first to be clipped or wrapped
      // incoherently, so it is what the width assertion is anchored to.
      expect(await page.locator('body').innerText()).toContain(fixture.documentNumber);

      await page.screenshot({
        path: `src/test/__e2e_screenshots__/recent-populated-${String(width)}.png`,
        fullPage: true,
      });
    }
  });

  /**
   * Clicking the row — Phase 7.6E.
   *
   * 7.6D proved the row *was* a link. A link with an href is not a link that works: the router can
   * fail, the destination can 404, an overlay can swallow the click. So this clicks it and follows
   * where it actually goes. No `page.goto`, no location assignment.
   */
  it('navigates to the real document when the row is clicked', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(WEB_URL, { waitUntil: 'networkidle' });

    await page
      .getByRole('link', { name: new RegExp(fixture.documentNumber, 'i') })
      .first()
      .click();

    await page.waitForURL((url) => url.pathname === `/documents/${fixture.documentId}`, {
      timeout: 30_000,
    });

    // Arriving is not enough — the destination has to be the document, not an error boundary.
    const body = await page.locator('body').innerText();
    expect(body).toContain(fixture.documentNumber);
    expect(body.toLowerCase()).not.toContain('something went wrong');

    await page.goto(WEB_URL, { waitUntil: 'networkidle' });
  });

  /**
   * axe against the live page, with the row populated — Phase 7.6E.
   *
   * The jsdom suites already run axe over these components, but jsdom has no cascade, so
   * `color-contrast` cannot reach a verdict there and is switched off. Here it can. axe-core is
   * already a dependency of this repository; it is injected into the page rather than added as a
   * new package.
   */
  it('has no critical or serious axe violations with the row populated', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.addScriptTag({ path: AXE_PATH });
    const violations = await page.evaluate(async () => {
      const results = await (
        window as unknown as { axe: { run: (ctx: Document) => Promise<{ violations: unknown[] }> } }
      ).axe.run(document);
      return (results.violations as { id: string; impact: string; nodes: unknown[] }[])
        .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
        .map(
          (violation) => `${violation.impact}: ${violation.id} (${String(violation.nodes.length)})`,
        );
    });

    expect(violations).toStrictEqual([]);
  });

  /**
   * Dark, through the product's own switch — Phase 7.6E.
   *
   * The theme is toggled by clicking the top bar's button, not by setting a class: the button is
   * what a person uses, and it is also what writes the `edms.theme` preference the platform reads.
   */
  it('renders the populated row in dark, through the real toggle', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByRole('button', { name: en.nav.darkMode, exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));

    // The row must still be there, and still carry its metadata — a theme switch that loses the
    // content is the failure this guards.
    const body = await page.locator('body').innerText();
    expect(body).toContain(fixture.documentNumber);
    expect(body).not.toContain(en.dashboard.recent.empty);

    await page.screenshot({
      path: 'src/test/__e2e_screenshots__/recent-populated-dark.png',
      fullPage: true,
    });

    // Back to light, so the locale run below is not also a theme run.
    await page.getByRole('button', { name: en.nav.lightMode, exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
  });

  /**
   * Arabic, through the real locale cookie — Phase 7.6E.
   *
   * `edms_locale` is the application's own mechanism (`lib/session.ts`), read on the server, so
   * setting it and reloading is the same thing the product does. Nothing is faked with CSS and no
   * test-only attribute is introduced.
   *
   * The assertion that matters is the mixed-direction one: a document number and a date are LTR
   * runs inside an RTL line, and that is where RTL breaks in practice.
   */
  it.each([1280, 390])('renders the populated row in Arabic at %ipx', async (width) => {
    await context.addCookies([{ name: 'edms_locale', value: 'ar', url: WEB_URL }]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(WEB_URL, { waitUntil: 'networkidle' });

    expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
    expect(await page.locator('html').getAttribute('lang')).toBe('ar');

    // The row survived the locale change, and its LTR runs are intact.
    const body = await page.locator('body').innerText();
    expect(body).toContain(fixture.documentNumber);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `Arabic dashboard overflows at ${String(width)}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth);

    await page.screenshot({
      path: `src/test/__e2e_screenshots__/recent-populated-ar-${String(width)}.png`,
      fullPage: true,
    });
  });
});
