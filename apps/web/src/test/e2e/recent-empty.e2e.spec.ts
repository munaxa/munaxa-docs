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

const RECENT = '/documents/recent';

/**
 * The empty Recently-opened screen, in the running product — Phase 8.1.
 *
 * ## Why the state is real rather than arranged
 *
 * The signer this suite creates has **opened nothing**. `RecentDocument` rows come from
 * `DocumentService.open()` recording a view (Phase 7.6D established that path), so a session that
 * never opens a document has a genuinely empty list. Nothing is deleted, truncated or stubbed to
 * produce it — the empty state is simply what a new account sees, which is exactly the state Phase
 * 8 found unrendered.
 *
 * ## What it guards
 *
 * That the *page* survives the empty branch: one `<h1>`, the breadcrumb back to the library, and
 * the empty state inside them rather than instead of them. The screen used to return
 * `<EmptyState />` before reaching `WorkspacePage`, and Phase 8 measured `h1Count: 0`.
 */
describe('recently opened, with nothing opened, in the running product', () => {
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
    await page.goto(`${WEB_URL}${RECENT}`, { waitUntil: 'networkidle' });
  }, 240_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  it('is genuinely empty, and says so', async () => {
    const body = await page.locator('body').innerText();
    expect(body, 'this account has opened something — the state under test is not empty').toContain(
      en.documents.recent.empty,
    );
    expect(body).toContain(en.documents.recent.emptyHint);
    expect(body.toLowerCase()).not.toContain('something went wrong');
  });

  /** The defect, stated as the thing a screen reader would have found missing. */
  it('has exactly one page heading, and it names the page', async () => {
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('main h1')].map((node) => node.textContent?.trim() ?? ''),
    );
    console.log('[recent empty headings]', JSON.stringify(headings));
    expect(headings).toStrictEqual([en.documents.nav.recent]);
  });

  it('keeps the breadcrumb back to the library', async () => {
    const trail = page.getByRole('navigation', { name: en.nav.breadcrumb });
    await trail.waitFor({ state: 'visible' });
    expect(await trail.getByRole('link', { name: en.nav.documents }).getAttribute('href')).toBe(
      '/documents',
    );
  });

  /** Present is not reachable: the crumb has to actually navigate. */
  it('navigates back to the library when the crumb is clicked', async () => {
    await page
      .getByRole('navigation', { name: en.nav.breadcrumb })
      .getByRole('link', { name: en.nav.documents })
      .click();
    await page.waitForURL((url) => url.pathname === '/documents', { timeout: 30_000 });

    await page.goto(`${WEB_URL}${RECENT}`, { waitUntil: 'networkidle' });
  });

  it.each(WIDTHS)('contains the empty screen at %ipx', async (width) => {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => document.readyState === 'complete');

    const measured = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      headings: document.querySelectorAll('main h1').length,
    }));
    expect(
      measured.scrollWidth,
      `the empty recent screen overflows at ${String(width)}px`,
    ).toBeLessThanOrEqual(measured.clientWidth);
    expect(measured.headings, `the heading is lost at ${String(width)}px`).toBe(1);

    if (width === 1280 || width === 390) {
      await page.screenshot({
        path: `src/test/__e2e_screenshots__/recent-empty-${String(width)}.png`,
        fullPage: true,
      });
    }
  });

  it('renders in dark through the real toggle', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: en.nav.darkMode, exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));

    const body = await page.locator('body').innerText();
    expect(body).toContain(en.documents.recent.empty);
    expect(await page.evaluate(() => document.querySelectorAll('main h1').length)).toBe(1);
    // The canvas Phase 7.8 fixed, checked here too — a themed shell over a white page is the
    // failure this screen would show most plainly, since it is nearly all page.
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );

    await page.screenshot({
      path: 'src/test/__e2e_screenshots__/recent-empty-dark.png',
      fullPage: true,
    });

    await page.getByRole('button', { name: en.nav.lightMode, exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
  });

  it.each([1280, 390])('renders in Arabic at %ipx', async (width) => {
    await context.addCookies([{ name: 'edms_locale', value: 'ar', url: WEB_URL }]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${WEB_URL}${RECENT}`, { waitUntil: 'networkidle' });

    expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
    expect(await page.locator('html').getAttribute('lang')).toBe('ar');
    expect(await page.evaluate(() => document.querySelectorAll('main h1').length)).toBe(1);

    const body = await page.locator('body').innerText();
    expect(body, 'a raw message key reached the Arabic screen').not.toMatch(/documents\.[a-zA-Z]/);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `Arabic recent overflows at ${String(width)}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth);

    await page.screenshot({
      path: `src/test/__e2e_screenshots__/recent-empty-ar-${String(width)}.png`,
      fullPage: true,
    });

    await context.clearCookies({ name: 'edms_locale' });
    await page.goto(`${WEB_URL}${RECENT}`, { waitUntil: 'networkidle' });
  });

  it('has no critical or serious axe violations', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addScriptTag({ path: AXE_PATH });

    const violations = await page.evaluate(async () => {
      const results = await (
        window as unknown as { axe: { run: (ctx: Document) => Promise<{ violations: unknown[] }> } }
      ).axe.run(document);
      return (results.violations as { id: string; impact: string; nodes: { target: string[] }[] }[])
        .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
        .flatMap((violation) =>
          violation.nodes.map(
            (node) => `${violation.impact}: ${violation.id} ${node.target.join(' ')}`,
          ),
        );
    });

    console.log('[axe recent-empty]', JSON.stringify(violations));
    expect(violations).toStrictEqual([]);
  });

  /**
   * The frame is reachable, not merely present.
   *
   * A heading in the DOM that no keyboard user can get to would satisfy the assertion above and
   * still leave the page unusable, so this walks to the breadcrumb from the top of the document.
   */
  it('is operable from the keyboard', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      document.body.focus();
    });

    const reached = { skip: false, crumb: false, outlined: false };
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) {
          return null;
        }
        const style = getComputedStyle(active);
        return {
          href: active.getAttribute('href') ?? '',
          inBreadcrumb: active.closest('nav[aria-label]') !== null && active.tagName === 'A',
          text: (active.textContent ?? '').trim(),
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
      if (stop.inBreadcrumb && stop.href === '/documents' && stop.text === en.nav.documents) {
        reached.crumb = true;
      }
      if (reached.skip && reached.crumb) {
        break;
      }
    }

    expect(reached).toStrictEqual({ skip: true, crumb: true, outlined: true });
  });
});
