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

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const WIDTHS = [1440, 1280, 1024, 768, 640, 390] as const;

/**
 * The search bar, measured in the running product — Phase 7.7A.
 *
 * Phase 7.7 saw the query field take a row of its own at 1280 while the sort control, "Search" and
 * "Save search" sat on the next, and deliberately stopped without diagnosing it: the class involved
 * is `flex-1 basis-full sm:basis-auto`, three rules competing for one `flex-basis`, and the
 * `basis-full` half is load-bearing — Phase 7.1 added it to stop "Save search" hanging 24px past a
 * 390px viewport.
 *
 * So this reads computed styles rather than inferring them from Tailwind, and it does so on one
 * authenticated session resized six times, for the rate-limit reason Phase 7.1C established.
 */
describe('search bar in the running application', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

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
    await page.goto(`${WEB_URL}/search`, { waitUntil: 'networkidle' });
  }, 240_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  it('renders the search screen', async () => {
    await page.getByRole('heading', { name: en.search.title, level: 1 }).waitFor({
      state: 'visible',
    });
  });

  /**
   * The measurement this phase exists for.
   *
   * `offsetTop` of the query field against the submit button is the honest test of "are these on
   * one row": two controls on the same flex line share a top edge, and two on different lines do
   * not. It does not depend on knowing which CSS property caused the wrap.
   */
  it.each(WIDTHS)('measures the search bar at %ipx', async (width) => {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => document.readyState === 'complete');

    const measured = await page.evaluate(() => {
      const field = document.querySelector('input[name="q"]');
      const form = field?.closest('form');
      const submit = form?.querySelector('button[type="submit"]');
      if (!(field instanceof HTMLElement) || !(submit instanceof HTMLElement) || form === null) {
        return null;
      }
      const style = getComputedStyle(field);
      return {
        parentWidth: (form as HTMLElement).getBoundingClientRect().width,
        fieldWidth: field.getBoundingClientRect().width,
        fieldTop: Math.round(field.getBoundingClientRect().top),
        submitTop: Math.round(submit.getBoundingClientRect().top),
        flexBasis: style.flexBasis,
        flexGrow: style.flexGrow,
        flexShrink: style.flexShrink,
        minWidth: style.minWidth,
        wrapped:
          Math.abs(field.getBoundingClientRect().top - submit.getBoundingClientRect().top) > 4,
      };
    });

    expect(measured).not.toBeNull();
    // Printed as well as asserted: the numbers are the deliverable of Step 2 and go into the report
    // verbatim, but the assertion below is what protects the fix.
    console.log(`[search-bar ${String(width)}]`, JSON.stringify(measured));

    /**
     * One row above `sm`, its own row below it.
     *
     * Tailwind's `sm` is 640px, and that is the breakpoint the field's basis switches on. Sharing a
     * top edge with the submit button is what "one coherent search interaction" means measurably —
     * it is the defect Phase 7.7 saw, stated as a number rather than as an impression.
     *
     * The 390 case asserts the *opposite*, deliberately: Phase 7.1 put the field on its own line
     * there so "Save search" would stop hanging past the viewport, and a fix for the desktop wrap
     * that quietly undid that would be a regression this test has to catch.
     */
    expect(
      measured?.wrapped,
      width >= 640
        ? `the query field should share a row with Search at ${String(width)}px`
        : `the query field should keep its own row at ${String(width)}px (Phase 7.1)`,
    ).toBe(width < 640);

    // Reachable, not merely present: a control scrolled out of the viewport is not usable.
    const saveInView = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('form button')];
      const last = buttons.at(-1);
      if (!(last instanceof HTMLElement)) {
        return true;
      }
      const box = last.getBoundingClientRect();
      return box.left >= 0 && box.right <= document.documentElement.clientWidth;
    });
    expect(saveInView, `a form control sits outside the viewport at ${String(width)}px`).toBe(true);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `search overflows at ${String(width)}px`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );

    await page.screenshot({
      path: `src/test/__e2e_screenshots__/search-${String(width)}.png`,
      fullPage: true,
    });
  });

  /**
   * Making the seeded document searchable, through the product's own reindex — Phase 7.7B.
   *
   * The fixture inserts document rows directly and never writes `search_index_entry`; indexing is
   * application work in `postgres-index.adapter.ts`, not a database trigger. The product owns the
   * remedy — `POST /api/v1/search/rebuild`, an operator action — so that is what runs here. No row
   * is written into the index, no event constructed, no handler called directly.
   *
   * **The bearer is the session's own, not a minted one.** `lib/session.ts` keeps the access token
   * in the `edms_at` cookie and the web app sends it onward to the API; reading that cookie from
   * the authenticated context is therefore the same credential the application itself would use.
   * Nothing is signed here and authentication is not bypassed.
   *
   * The earlier attempt failed because it called the *web* origin: Next.js answered its own
   * catch-all with HTML and the request never reached NestJS. `bootstrap.ts` sets a global `api`
   * prefix and URI versioning, so the real route is `/api/v1/...` on port 3001.
   */
  it('reindexes the seeded document through the real operator endpoint', async () => {
    const cookies = await context.cookies();
    const token = cookies.find((cookie) => cookie.name === 'edms_at')?.value;
    expect(token, 'the signed-in session must carry an access token').toBeTruthy();

    const api = `http://127.0.0.1:${String(API_PORT)}/api/v1`;
    const headers = { Authorization: `Bearer ${token ?? ''}` };

    const started = await page.request.post(`${api}/search/rebuild`, { headers });
    console.log('[rebuild POST]', started.status(), (await started.text()).slice(0, 200));
    expect(started.ok(), 'the operator reindex must accept the session bearer').toBe(true);

    // The product's own status endpoint, polled rather than slept on.
    await expect
      .poll(
        async () => {
          const status = await page.request.get(`${api}/search/rebuild`, { headers });
          if (!status.ok()) {
            return `http ${String(status.status())}`;
          }
          const body = (await status.json()) as { state?: string };
          return body.state ?? 'unknown';
        },
        { timeout: 90_000, interval: 1_000 },
      )
      .not.toBe('RUNNING');
  });

  it('returns the seeded document for a real query', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB_URL}/search`, { waitUntil: 'networkidle' });

    await page.getByRole('searchbox').fill(fixture.documentNumber);
    await page.getByRole('button', { name: en.search.submit, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('q') === fixture.documentNumber, {
      timeout: 30_000,
    });
    await page.waitForLoadState('networkidle');

    const body = await page.locator('body').innerText();
    console.log('[search body]', body.slice(0, 700));
    expect(body).toContain(fixture.documentNumber);
    expect(body).not.toContain(en.search.empty);

    await page.screenshot({
      path: 'src/test/__e2e_screenshots__/search-populated-1440.png',
      fullPage: true,
    });
  });
});
