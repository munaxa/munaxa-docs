import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * The platform's `DataGrid` row-action menu, opened from the keyboard, in the running product.
 *
 * Phase 8.7 found this in Storybook: `DataGrid`'s key handler sits on the `<table>`, so Enter
 * pressed on a control *inside* a cell bubbled to the grid, which activated the row and called
 * `preventDefault()` — stopping the control's own handler. The menu opened with a mouse and not
 * with a keyboard, which is a WCAG 2.1.1 failure and existed in every product table built on the
 * component.
 *
 * The surface has to be chosen with care. `ResourceList` puts a `DropdownMenu` trigger in a
 * `DataGrid` row-action cell on every admin list, but the defect only bites where the grid also
 * has an `onRowActivate` to run: without one the old code reached the end of its `Enter` branch,
 * called no `preventDefault`, and the button's own handler survived. `/admin/users` sets no
 * `onRowActivate` and therefore passes on both versions — `/admin/libraries` and
 * `/admin/workflows` are the surfaces that reproduce it.
 *
 * This asserts the fix through the **installed package** rather than the platform source — Phase
 * 8.8 exists to prove Docs consumes the published artifact, and a source-tree assertion would
 * prove nothing about what was installed.
 */

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/*
 * The *row* trigger, not the toolbar's column menu. Both are `aria-haspopup="menu"`, and the
 * toolbar one sits outside the table — where the defect could never occur, because the grid's
 * handler is not in its bubble path. Scoping to a cell inside the grid is the whole point.
 */
const ROW_TRIGGER = '[role="grid"] [data-cell] [aria-haspopup="menu"]';

/** Admin lists that pass `onRowActivate`, which is what makes the defect reachable. */
const CANDIDATES = ['/admin/libraries', '/admin/workflows'] as const;

describe('the platform DataGrid row menu, from the keyboard, in the running product', () => {
  let fixture: Fixture;
  let servers: Servers;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let route: string | null = null;

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

    // Whichever list the fixture actually populated: an empty grid has no row menu to press.
    for (const candidate of CANDIDATES) {
      await page.goto(`${WEB_URL}${candidate}`, { waitUntil: 'networkidle' });
      if ((await page.locator(ROW_TRIGGER).count()) > 0) {
        route = candidate;
        break;
      }
    }
  }, 240_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  it('puts the row-actions trigger inside a grid cell, which is the shape that broke', async () => {
    const shape = await page.evaluate((selector) => {
      const trigger = document.querySelector(selector);
      return {
        found: trigger !== null,
        inCell: trigger?.closest('[data-cell]') !== null && trigger !== null,
        inGrid: trigger?.closest('[role="grid"]') !== null && trigger !== null,
        // Listed so a failure says which menus the page does have rather than only that it lacks
        // the one asked for.
        allMenuTriggers: [...document.querySelectorAll('[aria-haspopup="menu"]')].map(
          (el) => el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20) ?? '?',
        ),
      };
    }, ROW_TRIGGER);
    expect(
      { route: route !== null, found: shape.found, inCell: shape.inCell, inGrid: shape.inGrid },
      `no row-actions trigger in a grid cell on ${CANDIDATES.join(' or ')}; menus present: ${shape.allMenuTriggers.join(', ')}`,
    ).toStrictEqual({ route: true, found: true, inCell: true, inGrid: true });
  }, 120_000);

  it('opens the row menu on Enter, and does not activate the row underneath', async () => {
    expect(
      route,
      'no populated admin list with row actions — the proof needs that surface',
    ).not.toBe(null);
    await page.goto(`${WEB_URL}${route ?? ''}`, { waitUntil: 'networkidle' });

    // The mouse path first, so a failure of the keyboard path cannot be confused with a menu that
    // does not work at all.
    await page.locator(ROW_TRIGGER).first().click();
    await page.waitForSelector('[role="menu"]', { timeout: 5_000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="menu"]', { state: 'detached', timeout: 5_000 });

    /*
     * The keyboard path, from a fresh load so the grid's own focus state is where a person's would
     * be. Measured against platform 1.3.0 this is what happened instead: no menu, and the URL
     * became `/admin/libraries/<id>/folders` — the grid activated the row and the button's own
     * handler never ran. Both halves are asserted, because a menu that opens while the page also
     * navigates away is not a working control.
     */
    await page.goto(`${WEB_URL}${route ?? ''}`, { waitUntil: 'networkidle' });
    const before = page.url();
    await page.locator(ROW_TRIGGER).first().focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);

    const outcome = {
      menuOpen: (await page.locator('[role="menu"]').count()) > 0,
      navigated: page.url() !== before,
    };
    expect(
      outcome,
      'Enter on the row-actions trigger — the Phase 8.7 defect is back',
    ).toStrictEqual({ menuOpen: true, navigated: false });
  }, 120_000);

  it('is the installed package, at the version that carries the fix', () => {
    /*
     * Walked up from the resolved entry point rather than imported: the package deliberately does
     * not export `./package.json`. The point is that this reads what pnpm installed — the registry
     * tarball under `node_modules/.pnpm` — and never the platform source tree.
     */
    const entry = createRequire(import.meta.url).resolve('@munaxa/platform');
    let dir = path.dirname(entry);
    let manifest: { version: string; name: string } | null = null;
    for (let up = 0; up < 6 && manifest === null; up += 1) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) {
        manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { version: string; name: string };
      }
      dir = path.dirname(dir);
    }

    expect(manifest?.name).toBe('@munaxa/platform');

    /*
     * A floor, not a pin — Phase 8.12.
     *
     * This assertion exists to prove Docs consumes the published artifact that carries the
     * `DataGrid` fix, and 1.3.1 is where that fix landed. Pinning the exact version made it fail on
     * the next release for no accessibility reason at all, which teaches a team to edit the test
     * rather than read it. The floor keeps the claim and survives a bump.
     */
    const [major = 0, minor = 0, patch = 0] = (manifest?.version ?? '0.0.0')
      .split('.')
      .map((part) => Number.parseInt(part, 10));
    const atLeast131 = major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 1)));
    expect(
      atLeast131,
      `installed ${String(manifest?.version)}; the DataGrid keyboard fix ships from 1.3.1`,
    ).toBe(true);
    expect(
      entry,
      'resolved outside the pnpm store — that would not be the published artifact',
    ).toContain('node_modules/.pnpm/@munaxa+platform@');
  }, 60_000);
});
