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

/*
 * 320 is the narrowest, and it is the one that is not a guess — Phase 8.17.
 *
 * WCAG 2.1 **AA** 1.4.10 Reflow names 320 CSS px exactly: content has to reflow to that width
 * without requiring scrolling in two dimensions. This list went down to 390, a device width, so
 * the criterion itself had never been tested anywhere in either repository.
 *
 * It was measured before it was added: twelve routes at 320 and at 390, both themes — zero
 * horizontal overflow and zero axe violations. So this locks in a property the product already
 * has rather than announcing a new one, which is the only honest reason to add a width.
 */
const WIDTHS = [1440, 1280, 1024, 768, 640, 390, 320] as const;

/** axe-core is already a dependency here; it is injected into the live page, not added anew. */
const AXE_PATH = require.resolve('axe-core/axe.min.js');

/**
 * The seeded document's title, from `scripts/e2e-signature-fixture.mjs`.
 *
 * The `Fixture` contract carries the number, the revision and the ids but not the title, and
 * widening it for one assertion would touch six suites. This is the same string the script writes.
 */
const DOCUMENT_TITLE = 'Batch release procedure';

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

  /**
   * The result row, read from the running application — Phase 7.7B.
   *
   * `Rev Rev 0` was found by looking at the previous pass's screenshot, and it is guarded twice:
   * here against the real product with the real fixture label, and in
   * `features/search/search-results.spec.tsx` against the labels the domain actually mints. The
   * jsdom test is the sharper one; this is the one that would have caught it.
   */
  it('names the revision once in the running application', async () => {
    await gotoPopulated(page, fixture.documentNumber);

    const body = await page.locator('body').innerText();
    expect(body, 'the revision label is prefixed with a redundant "Rev"').not.toMatch(/Rev\s+Rev/);
    expect(body).toContain(fixture.revisionLabel);
  });

  /**
   * Six widths, with a result on screen — Phase 7.7B.
   *
   * Phase 7.7A measured the *bar* at these widths against an empty screen. A result row has a
   * title, a status, a type, a number, a revision and a date in it, and the 1440 screenshot from
   * the previous pass showed the revision clipped by the card's own border. So this measures the
   * row as well: every part readable, nothing outside its card, no page-level overflow.
   */
  it.each(WIDTHS)('keeps the populated result usable at %ipx', async (width) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoPopulated(page, fixture.documentNumber);

    const body = await page.locator('body').innerText();
    expect(body, `the result title is missing at ${String(width)}px`).toContain(DOCUMENT_TITLE);
    expect(body, `the document number is missing at ${String(width)}px`).toContain(
      fixture.documentNumber,
    );
    expect(body, `the revision is missing at ${String(width)}px`).toContain(fixture.revisionLabel);
    expect(body, `the result count is missing at ${String(width)}px`).toMatch(/1 of 1/);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `populated search overflows at ${String(width)}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth);

    /*
     * Inside its own card, not merely inside the page.
     *
     * This is the assertion the previous pass's screenshot demanded: `Rev Rev 0` ran past the
     * result card's right border while the *page* had no horizontal scrollbar at all, so a
     * document-level overflow check would have called it clean.
     */
    const contained = await page.evaluate(() => {
      const card = document.querySelector('main ul li a > *');
      if (!(card instanceof HTMLElement)) {
        return null;
      }
      const bounds = card.getBoundingClientRect();
      return [...card.querySelectorAll('*')].every((child) => {
        const box = child.getBoundingClientRect();
        return box.width === 0 || (box.left >= bounds.left - 1 && box.right <= bounds.right + 1);
      });
    });
    expect(contained, `result content escapes its card at ${String(width)}px`).toBe(true);

    await page.screenshot({
      path: `src/test/__e2e_screenshots__/search-populated-${String(width)}.png`,
      fullPage: true,
    });
  });

  /**
   * The zero-result state — Phase 7.7B, and the render A3 has to be decided against.
   *
   * Phase 7.7's A3 said the result count renders "orphaned and centred". The previous pass showed
   * that is not true with results present. This captures the other state so the finding is settled
   * by a render rather than by either phase's recollection.
   */
  it('renders the zero-result state for a query that matches nothing', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoPopulated(page, 'zzz-matches-nothing-zzz');

    const body = await page.locator('body').innerText();
    expect(body).toContain(en.search.empty);
    expect(body).toMatch(/0 of 0/);

    await page.screenshot({
      path: 'src/test/__e2e_screenshots__/search-zero-results-1440.png',
      fullPage: true,
    });
  });

  /**
   * A real click on a real result, followed to a real document — Phase 7.7B.
   *
   * Not `page.goto`, not an `href` read: the presence of an attribute is not navigation, which is
   * the standard Phase 7.6E set for the dashboard's rows.
   */
  it('opens the document when the result is clicked', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoPopulated(page, fixture.documentNumber);

    await page
      .getByRole('link', { name: /procedure/i })
      .first()
      .click();
    await page.waitForURL((url) => /\/documents\/[0-9a-f-]{36}/.test(url.pathname), {
      timeout: 30_000,
    });
    await page.waitForLoadState('networkidle');

    expect(page.url()).toContain(`/documents/${fixture.documentId}`);
    const body = await page.locator('body').innerText();
    expect(body).toContain(fixture.documentNumber);
    expect(body.toLowerCase()).not.toContain('something went wrong');
  });

  /**
   * The screen operated from the keyboard — Phase 7.7B.
   *
   * No count of Tab presses is asserted: that is a test of the DOM order, not of whether a person
   * can work. What is asserted is that walking forward from the query field reaches the submit
   * button, a facet control and the result link, and that focus is visible at each stop.
   */
  it('is operable from the keyboard with a result on screen', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoPopulated(page, fixture.documentNumber);

    await page.getByRole('searchbox').focus();

    const reached = { submit: false, facet: false, result: false, outlined: false };
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) {
          return null;
        }
        const style = getComputedStyle(active);
        return {
          tag: active.tagName,
          type: active.getAttribute('type'),
          pressed: active.getAttribute('aria-pressed'),
          href: active.getAttribute('href'),
          // A visible ring — an outline or a box-shadow. Either satisfies "focus is visible"; a
          // control with neither is unusable for anybody navigating without a pointer.
          outlined: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
        };
      });
      if (stop === null) {
        continue;
      }
      if (stop.outlined) {
        reached.outlined = true;
      }
      if (stop.tag === 'BUTTON' && stop.type === 'submit') {
        reached.submit = true;
      }
      if (stop.pressed !== null) {
        reached.facet = true;
      }
      if (stop.href !== null && stop.href.includes('/documents/')) {
        reached.result = true;
      }
      if (reached.submit && reached.facet && reached.result) {
        break;
      }
    }

    expect(reached).toStrictEqual({ submit: true, facet: true, result: true, outlined: true });
  });

  /**
   * axe against the live populated screen — Phase 7.7B.
   *
   * jsdom has no cascade, so `color-contrast` cannot reach a verdict there. Here it can, and it is
   * left on.
   */
  it('has no critical or serious axe violations with a result on screen', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoPopulated(page, fixture.documentNumber);

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

  /** Dark, through the top bar's own switch rather than by setting a class. */
  it('renders the populated result in dark, through the real toggle', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoPopulated(page, fixture.documentNumber);

    await page.getByRole('button', { name: en.nav.darkMode, exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));

    const body = await page.locator('body').innerText();
    expect(body).toContain(fixture.documentNumber);
    expect(body).not.toContain(en.search.empty);

    /*
     * Measured rather than asserted, and the reason is in the report.
     *
     * The dark screenshot shows a dark shell and dark panels over a **light page canvas**. The same
     * is true of `recent-populated-dark.png` from Phase 7.6E, so it is product-wide and predates
     * this phase — Search did not cause it and a Search-scoped phase is the wrong place to change a
     * background every screen shares. Printing the computed values keeps the finding evidence-based
     * instead of an impression of a picture.
     */
    console.log(
      '[dark canvas]',
      JSON.stringify(
        await page.evaluate(() => ({
          html: getComputedStyle(document.documentElement).backgroundColor,
          body: getComputedStyle(document.body).backgroundColor,
          main: getComputedStyle(document.querySelector('main') ?? document.body).backgroundColor,
          dark: document.documentElement.classList.contains('dark'),
        })),
      ),
    );

    await page.screenshot({
      path: 'src/test/__e2e_screenshots__/search-populated-dark.png',
      fullPage: true,
    });

    await page.getByRole('button', { name: en.nav.lightMode, exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
  });

  /**
   * Arabic, through the real `edms_locale` cookie — Phase 7.7B.
   *
   * Nothing is faked with CSS. The assertion that matters is the mixed-direction one: the document
   * number and the revision label are LTR runs inside an RTL line, and that is where RTL breaks.
   */
  it.each([1280, 390])('renders the populated result in Arabic at %ipx', async (width) => {
    await context.addCookies([{ name: 'edms_locale', value: 'ar', url: WEB_URL }]);
    await page.setViewportSize({ width, height: 900 });
    await gotoPopulated(page, fixture.documentNumber);

    expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
    expect(await page.locator('html').getAttribute('lang')).toBe('ar');

    const body = await page.locator('body').innerText();
    expect(body, `the document number is lost in Arabic at ${String(width)}px`).toContain(
      fixture.documentNumber,
    );
    expect(body, `the revision is lost in Arabic at ${String(width)}px`).toContain(
      fixture.revisionLabel,
    );
    expect(body, 'a raw message key reached the Arabic screen').not.toMatch(/search\.[a-zA-Z]/);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `Arabic search overflows at ${String(width)}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth);

    await page.screenshot({
      path: `src/test/__e2e_screenshots__/search-populated-ar-${String(width)}.png`,
      fullPage: true,
    });

    await context.clearCookies({ name: 'edms_locale' });
  });
});

/**
 * The same workspace, opened by somebody who is not an administrator — Slice 10.
 *
 * ## Why this suite needed a second persona
 *
 * Every test above signs in as `fixture.signer`, whose role is seeded with `ALL_PERMISSIONS`. That
 * is right for the signing case it was written for and blind to an authorization one: twenty-five
 * green search tests ran, and none of them could have noticed that `/search` fetched four
 * administrative datasets to caption its facets and threw the whole render when they were refused.
 *
 * Measured on the running stack before the fix: the seeded **auditor** and **document controller**
 * both got the route error boundary — no heading, no search box, no results — while `/search`,
 * `/search/saved` and `/search/recent` all answered 200 for them. The workspace was unusable for
 * two of the three roles that can open it, and the search API was never the problem.
 *
 * So this signs in as the product's own auditor — `DEFAULT_ROLE_PERMISSIONS.AUDITOR`, imported by
 * the fixture rather than typed out, with nothing added for the test's convenience — and does what
 * an auditor comes here to do.
 */
describe('search as the seeded auditor, who administers nothing', () => {
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
      fixture.auditor.email,
      fixture.password,
      fixture.slug,
    );
    context = await browser.newContext({
      storageState: state,
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();

    /*
     * The index is built by an administrator, and searched by everybody else.
     *
     * The fixture writes its documents straight into the database, so nothing has been indexed yet
     * — the suite above reindexes for exactly this reason. It is done here as the **signer**, who
     * holds `settings:manage`, because that is who does it in production: `POST /search/rebuild`
     * is the one operator act on the search controller and it is gated accordingly. The auditor's
     * own grants are not touched, which is the whole point of this block.
     */
    const operator = await browser.newContext({
      storageState: await signInAndCapture(
        browser,
        WEB_URL,
        fixture.signer.email,
        fixture.password,
        fixture.slug,
      ),
    });
    const operatorPage = await operator.newPage();
    const token = (await operator.cookies()).find((cookie) => cookie.name === 'edms_at')?.value;
    const api = `http://127.0.0.1:${String(API_PORT)}/api/v1`;
    const headers = { Authorization: `Bearer ${token ?? ''}` };
    const started = await operatorPage.request.post(`${api}/search/rebuild`, { headers });
    if (!started.ok()) {
      throw new Error(`the operator reindex was refused: ${String(started.status())}`);
    }
    // Polled through the product's own status endpoint rather than slept on. `expect.poll` belongs
    // to a test body, and this is setup.
    const deadline = Date.now() + 90_000;
    let rebuildState = 'RUNNING';
    while (rebuildState === 'RUNNING' && Date.now() < deadline) {
      const status = await operatorPage.request.get(`${api}/search/rebuild`, { headers });
      rebuildState = status.ok()
        ? (((await status.json()) as { state?: string }).state ?? 'unknown')
        : 'unknown';
      if (rebuildState === 'RUNNING') {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (rebuildState === 'RUNNING') {
      throw new Error('the search index never finished rebuilding');
    }
    await operator.close();
  }, 300_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  it('opens the workspace rather than the route error boundary', async () => {
    await page.goto(`${WEB_URL}/search`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();

    expect(body, 'the auditor got the error boundary').not.toMatch(/something went wrong/i);
    await page
      .getByRole('heading', { name: en.search.title, level: 1 })
      .waitFor({ state: 'visible' });
  });

  it('runs a real search and gets results back', async () => {
    await gotoPopulated(page, fixture.documentNumber);
    const body = await page.locator('body').innerText();

    expect(body).not.toMatch(/something went wrong/i);
    expect(body, 'the auditor’s search returned nothing').toContain(fixture.documentNumber);
  });

  it('keeps the facet controls usable, labels or no labels', async () => {
    /*
     * The auditor holds neither `configuration:view` nor `directory:view`, so no label read is
     * issued at all and every bucket falls back to its raw value through `labels?.[value] ?? value`.
     * A caption is what degrades; the control is not allowed to.
     */
    await gotoPopulated(page, fixture.documentNumber);
    // The workspace first: a page that fell over has no facets either, and "no facets" must never
    // be how this test passes.
    expect(await page.locator('body').innerText()).not.toMatch(/something went wrong/i);
    await page
      .getByRole('heading', { name: en.search.title, level: 1 })
      .waitFor({ state: 'visible' });

    const facets = page.locator('aside button[aria-pressed]');
    const count = await facets.count();
    if (count === 0) {
      // A single-hit corpus can legitimately produce no bucket worth showing; the assertion that
      // matters then is the one above, that the page rendered at all.
      return;
    }
    for (let index = 0; index < count; index += 1) {
      const facet = facets.nth(index);
      expect(await facet.isVisible()).toBe(true);
      expect(await facet.isEnabled()).toBe(true);
      // A raw identifier is an acceptable caption; an empty one is not — that would be a bucket
      // nobody could read or aim at.
      expect((await facet.innerText()).trim().length).toBeGreaterThan(0);
    }
  });

  it('opens a result, which is what a search is for', async () => {
    await gotoPopulated(page, fixture.documentNumber);
    await page.locator(`main a[href^="/documents/"]`).first().click();
    await page.waitForURL(/\/documents\/[0-9a-f-]+/, { timeout: 30_000 });

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/something went wrong/i);
  });

  it('is still refused every administrative dataset, at the API', async () => {
    /*
     * The security half, and it is asserted through the API rather than the browser because that is
     * where the guard is. This slice removed a *dependency*; it must not have moved a boundary.
     */
    const login = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fixture.auditor.email,
        password: fixture.password,
        tenant: fixture.slug,
      }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };

    for (const path of [
      '/admin/document-types',
      '/admin/categories',
      '/admin/departments',
      '/admin/entities',
      '/configuration/document-types',
      '/configuration/categories',
      '/directory/departments',
    ]) {
      const refused = await fetch(
        `http://127.0.0.1:${String(API_PORT)}/api/v1${path}?pageSize=100`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      expect(refused.status, `${path} must still refuse the auditor`).toBe(403);
    }
  });

  it('can still reach the search API itself', async () => {
    // The other half of the same claim: nothing the auditor legitimately holds was taken away.
    const login = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fixture.auditor.email,
        password: fixture.password,
        tenant: fixture.slug,
      }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };

    for (const path of ['/search?sort=relevance&q=quality', '/search/saved', '/search/recent']) {
      const allowed = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1${path}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(allowed.status, `${path} must remain open to the auditor`).toBe(200);
    }
  });
});

/**
 * The populated screen, reached the way a link would reach it.
 *
 * The URL *is* this screen's state — `search-screen.tsx` says so and the server renders the first
 * page from it — so navigating to `/search?q=…` is the product's own path, not a shortcut around
 * the form. The form itself is exercised by the test above that types into it.
 */
async function gotoPopulated(page: Page, query: string): Promise<void> {
  await page.goto(`${WEB_URL}/search?q=${encodeURIComponent(query)}&sort=relevance`, {
    waitUntil: 'networkidle',
  });
}
