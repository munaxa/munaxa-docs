import { existsSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ar, en } from '@edms/i18n';

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

/**
 * The "Add documents" dialogue at common laptop sizes (Hetzner Phase B, finding 1).
 *
 * The platform's dialogue sets no height. At 1280×720 the upload form is ~900px tall, so its
 * submit button sat at 754–790px — below the window, in a panel nothing could scroll. Uploading
 * was impossible without a larger screen. This drives the real product at the sizes that failed:
 * the panel must fit the window, and the submit button must be reachable by scrolling the panel.
 */
describe('the upload dialogue fits the window and its submit button can be reached', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;
  let state: Awaited<ReturnType<typeof signInAndCapture>>;

  beforeAll(async () => {
    fixture = seedFixture();
    servers = await startServers(fixture);
    browser = await chromium.launch(
      existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {},
    );
    state = await signInAndCapture(
      browser,
      WEB_URL,
      fixture.signer.email,
      fixture.password,
      fixture.slug,
    );
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  async function openUpload(
    viewport: { width: number; height: number },
    locale: 'en' | 'ar',
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ storageState: state, viewport });
    if (locale === 'ar') {
      await context.addCookies([{ name: 'edms_locale', value: 'ar', url: WEB_URL }]);
    }
    const page = await context.newPage();
    await page.goto(
      `${WEB_URL}/documents?libraryId=${fixture.libraryId}&folderId=${fixture.folderId}`,
      { waitUntil: 'networkidle' },
    );
    const catalogue = locale === 'ar' ? ar : en;
    await page.getByRole('button', { name: catalogue.documents.actions.upload }).click();
    await page.getByRole('dialog').waitFor();
    return { context, page };
  }

  for (const [label, viewport, locale] of [
    ['1280×720', { width: 1280, height: 720 }, 'en'],
    ['1366×768', { width: 1366, height: 768 }, 'en'],
    ['1280×720, Arabic', { width: 1280, height: 720 }, 'ar'],
  ] as const) {
    it(`at ${label}`, async () => {
      const { context, page } = await openUpload(viewport, locale);
      try {
        const dialog = page.getByRole('dialog');
        const panel = await dialog.boundingBox();
        expect(panel).not.toBeNull();
        expect(panel!.y).toBeGreaterThanOrEqual(0);
        expect(panel!.y + panel!.height).toBeLessThanOrEqual(viewport.height);

        // The form is taller than the window, so the panel itself must scroll.
        const scrolls = await dialog.evaluate((el) => el.scrollHeight > el.clientHeight);
        expect(scrolls).toBe(true);

        const submit = dialog.locator('button[type="submit"]');
        await submit.scrollIntoViewIfNeeded();
        const button = await submit.boundingBox();
        expect(button).not.toBeNull();
        expect(button!.y).toBeGreaterThanOrEqual(0);
        expect(button!.y + button!.height).toBeLessThanOrEqual(viewport.height);
        // Nothing is drawn over it: the element at its centre is the button (or inside it).
        const onTop = await submit.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit !== null && el.contains(hit);
        });
        expect(onTop).toBe(true);
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
