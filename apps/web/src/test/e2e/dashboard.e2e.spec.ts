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
});
