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
 * The same workspace, opened by each role that can open it — Slices 10 and 11.
 *
 * ## Why this block exists
 *
 * Every test above signs in as `fixture.signer`, whose role is seeded with `ALL_PERMISSIONS`. That
 * is right for the signing case it was written for and blind to an authorization one: twenty-five
 * green search tests ran, and none of them could have noticed that `/search` fetched four
 * administrative datasets to caption its facets and threw the whole render when they were refused.
 *
 * Measured on the running stack before Slice 10: the seeded **auditor** and **document controller**
 * both got the route error boundary — no heading, no search box, no results — while `/search`,
 * `/search/saved` and `/search/recent` all answered 200 for them.
 *
 * Slice 10 made the four reads conditional, which fixed the page and left the auditor reading
 * UUIDs. Slice 11 moved the names into the search response, so the three roles below should now be
 * *indistinguishable* on this screen — same requests, same captions — while remaining exactly as
 * separated at the API, which the last two tests assert.
 *
 * The personas hold the product's own seeded grants, imported by the fixture rather than typed out,
 * with nothing added for the test's convenience.
 */
describe('search as each role that can open it', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;

  beforeAll(async () => {
    fixture = seedFixture();
    servers = await startServers(fixture);
    browser = await chromium.launch(
      existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {},
    );

    /*
     * The index is built by an administrator and searched by everybody else.
     *
     * The fixture writes its documents straight into the database, so nothing has been indexed yet.
     * It is done here as the **signer**, who holds `settings:manage`, because that is who does it
     * in production: `POST /search/rebuild` is the one operator act on the search controller and it
     * is gated accordingly. No persona's own grants are touched.
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
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  /** The three roles that hold `document:view` tenant-wide, by what they administer. */
  const PERSONAS = [
    { name: 'the auditor, who administers nothing', of: (f: Fixture) => f.auditor.email },
    { name: 'the document controller', of: (f: Fixture) => f.controller.email },
    { name: 'the tenant administrator', of: (f: Fixture) => f.signer.email },
  ] as const;

  for (const persona of PERSONAS) {
    describe(persona.name, () => {
      let context: BrowserContext;
      let page: Page;

      beforeAll(async () => {
        const state = await signInAndCapture(
          browser,
          WEB_URL,
          persona.of(fixture),
          fixture.password,
          fixture.slug,
        );
        context = await browser.newContext({
          storageState: state,
          viewport: { width: 1440, height: 900 },
        });
        page = await context.newPage();
      }, 180_000);

      afterAll(async () => {
        await context?.close();
      });

      it('opens the workspace rather than the route error boundary', async () => {
        await page.goto(`${WEB_URL}/search`, { waitUntil: 'networkidle' });

        expect(await page.locator('body').innerText()).not.toMatch(/something went wrong/i);
        await page
          .getByRole('heading', { name: en.search.title, level: 1 })
          .waitFor({ state: 'visible' });
      });

      it('runs a real search and gets results back', async () => {
        await gotoPopulated(page, fixture.documentNumber);
        const body = await page.locator('body').innerText();

        expect(body).not.toMatch(/something went wrong/i);
        expect(body, 'the search returned nothing').toContain(fixture.documentNumber);
      });

      it('reads the facet in words, resolved by the search API itself', async () => {
        /*
         * The change Slice 11 makes, from the seat of the person it was for. After Slice 10 the
         * auditor could search but read UUIDs, because the four label datasets sit behind
         * `settings:manage` and `org:manage` and it holds neither. The names travel with the
         * results now, so this caller reads the same captions a tenant administrator does — while
         * still being refused every one of those datasets, asserted below.
         *
         * `Standard operating procedure` is the fixture's own document type name. Finding it in the
         * facet rail proves the label arrived, because there is no other route by which it could.
         */
        await gotoPopulated(page, fixture.documentNumber);
        expect(await page.locator('body').innerText()).not.toMatch(/something went wrong/i);

        const rail = page.locator('aside');
        if ((await rail.count()) === 0) {
          return;
        }
        const railText = await rail.innerText();
        expect(railText, 'the facet rail carried no resolved name').toContain(
          'Standard operating procedure',
        );
        // And no bare identifier where a name belongs.
        expect(railText).not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
        );
        /*
         * What this does *not* cover, recorded rather than left to look covered — Slice 14.
         *
         * The `entity` facet is empty here and the assertion above is vacuous for it. The
         * projection writes `entity_id` only for a library owned by an `ENTITY` scope, or by a
         * `DEPARTMENT` belonging to one, and this fixture's library is owned by `TENANT` — as is
         * every other fixture in the repository. Changing that would alter the placement three
         * suites resolve their ACLs through, for a facet whose labelling is better proved where the
         * caller's permissions can be stated exactly.
         *
         * So it is proved in `search.integration.spec.ts`'s `the entity facet` block instead:
         * against two real tenants, with an entity-owned library, for a caller holding
         * `permissions: []` — no `org:manage`, nothing.
         */
      });

      it('filters by the facet it just read', async () => {
        // A caption nobody can act on is decoration. Pressing the bucket narrows the search, and
        // the value behind it is still the identifier — the label changed nothing about the filter.
        await gotoPopulated(page, fixture.documentNumber);
        const buckets = page.locator('aside button[aria-pressed]');
        if ((await buckets.count()) === 0) {
          return;
        }
        await buckets.first().click();
        // `navigate` pushes through `startTransition`, so this is a client transition rather than a
        // load — waiting for the network to go quiet can return before the URL has moved at all.
        await page.waitForURL(
          (url) =>
            ['type', 'category', 'department', 'entity', 'status', 'year'].some((key) =>
              url.searchParams.has(key),
            ),
          { timeout: 30_000 },
        );
        await page.waitForLoadState('networkidle');

        expect(await page.locator('body').innerText()).not.toMatch(/something went wrong/i);
        // The filter carries the identifier, not the caption: a label changed how the bucket reads
        // and nothing about what it filters by.
        const applied = new URL(page.url()).searchParams;
        const key = ['type', 'category', 'department', 'entity'].find((candidate) =>
          applied.has(candidate),
        );
        if (key !== undefined) {
          expect(applied.get(key)).not.toBe('Standard operating procedure');
        }
      });

      it('opens a result, which is what a search is for', async () => {
        await gotoPopulated(page, fixture.documentNumber);
        await page.locator(`main a[href^="/documents/"]`).first().click();
        await page.waitForURL(/\/documents\/[0-9a-f-]+/, { timeout: 30_000 });

        expect(await page.locator('body').innerText()).not.toMatch(/something went wrong/i);
      });
    });
  }

  it('still refuses the auditor every administrative and operational dataset', async () => {
    /*
     * The security half, asserted through the API rather than the browser because that is where the
     * guard is. Slices 10 and 11 removed a *dependency*; neither may have moved a boundary — and
     * the auditor now reads the same captions as an administrator while holding none of these keys,
     * which is precisely the claim worth checking.
     */
    const token = await bearerFor(fixture.auditor.email);

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
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(refused.status, `${path} must still refuse the auditor`).toBe(403);
    }
  });

  it('still refuses the document controller the organisation chart', async () => {
    // It holds the two operational read keys and neither management one, so the split must survive.
    const token = await bearerFor(fixture.controller.email);

    for (const [path, expected] of [
      ['/admin/entities', 403],
      ['/admin/departments', 403],
      ['/admin/document-types', 403],
      ['/configuration/document-types', 200],
      ['/directory/departments', 200],
    ] as const) {
      const answer = await fetch(
        `http://127.0.0.1:${String(API_PORT)}/api/v1${path}?pageSize=100`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(answer.status, `${path} answered unexpectedly for the controller`).toBe(expected);
    }
  });

  it('keeps the search API open to every one of them', async () => {
    // The other half of the same claim: nothing anybody legitimately held was taken away.
    for (const email of [fixture.auditor.email, fixture.controller.email, fixture.signer.email]) {
      const token = await bearerFor(email);
      for (const path of ['/search?sort=relevance&q=quality', '/search/saved', '/search/recent']) {
        const allowed = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(allowed.status, `${path} must remain open to ${email}`).toBe(200);
      }
    }
  });

  /** A bearer token for one of the fixture's people, through the real login endpoint. */
  async function bearerFor(email: string): Promise<string> {
    const login = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: fixture.password, tenant: fixture.slug }),
    });
    return ((await login.json()) as { accessToken: string }).accessToken;
  }
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
