import { existsSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { en } from '@edms/i18n';

import {
  type Fixture,
  type Servers,
  type StorageState,
  WEB_URL,
  cleanUpFixtures,
  emptyRedis,
  seedFixture,
  signInAndCapture,
  startServers,
  stopServers,
} from './servers';

/**
 * The login flow's `next`, in a real browser — RC validation, D-19.
 *
 * The defect lives in how a *browser* reads a `Location`: `/\evil.example` passed the old "starts
 * with one slash" test, and Chromium resolves it as `//evil.example`. A unit test of the validator
 * cannot show that; only a browser following the redirect can. So every case here is the real form,
 * the real server action, the real page, and Chromium's own URL handling — and what is asserted is
 * the invariant itself: no request the page makes, for any `next`, leaves this origin.
 *
 * Nothing external is ever contacted. Any request to another host is recorded and aborted at the
 * browser, so the evidence of an escape is the attempt, and the test does not depend on DNS.
 */

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const ORIGIN = new URL(WEB_URL).origin;
const SETTLE_MS = 2_000;

/** The browser-normalised case the defect was found with, and its relatives. */
const MALICIOUS = [
  '/\\evil.example',
  '//evil.example',
  '\\\\evil.example',
  'https://evil.example',
  'http://evil.example',
  '/\\/evil.example',
  '/.//evil.example',
  '/%2e%2e//evil.example',
] as const;

let fixture: Fixture;
let servers: Servers | null = null;
let browser: Browser;
let valid: StorageState;

/** Every host other than this one the context tried to reach, each attempt aborted. */
async function fence(context: BrowserContext): Promise<string[]> {
  const escapes: string[] = [];
  await context.route(
    (url) => url.origin !== ORIGIN,
    async (route) => {
      escapes.push(route.request().url());
      await route.abort('blockedbyclient');
    },
  );
  return escapes;
}

/** Waits until the main frame has stopped navigating for `SETTLE_MS`. */
async function atRest(page: Page): Promise<void> {
  let last = Date.now();
  const bump = (): void => {
    last = Date.now();
  };
  page.on('framenavigated', bump);
  page.on('request', bump);
  const deadline = Date.now() + 30_000;
  while (Date.now() - last < SETTLE_MS) {
    if (Date.now() > deadline) {
      throw new Error('The page never came to rest.');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  page.off('framenavigated', bump);
  page.off('request', bump);
}

function loginUrl(next: string): string {
  return `${WEB_URL}/login?next=${encodeURIComponent(next)}`;
}

async function signInThroughForm(page: Page, email: string): Promise<void> {
  await page.getByLabel(en.auth.emailLabel).fill(email);
  await page.getByLabel(en.auth.passwordLabel).fill(fixture.password);
  await page.getByLabel(en.auth.organisationLabel).fill(fixture.slug);
  await page.getByRole('button', { name: en.auth.signIn }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await atRest(page);
}

beforeAll(async () => {
  fixture = seedFixture();
  servers = await startServers(fixture);
  await emptyRedis(servers.redisUrl);
  browser = await chromium.launch(
    existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {},
  );
  valid = await signInAndCapture(
    browser,
    WEB_URL,
    fixture.signer.email,
    fixture.password,
    fixture.slug,
  );
}, 300_000);

afterAll(async () => {
  await browser?.close();
  stopServers(servers);
  cleanUpFixtures();
});

describe('signing in through the form (the server action)', () => {
  it('returns to an internal destination, query string included', async () => {
    const context = await browser.newContext();
    try {
      const escapes = await fence(context);
      const page = await context.newPage();
      await page.goto(loginUrl('/documents?page=1'));
      await signInThroughForm(page, fixture.reader.email);

      const landed = new URL(page.url());
      expect(landed.origin).toBe(ORIGIN);
      expect(`${landed.pathname}${landed.search}`).toBe('/documents?page=1');
      expect(escapes).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it.each(['/\\evil.example', '/.//evil.example', '\\\\evil.example'])(
    'stays on this origin, at home, for next=%j',
    async (next) => {
      const context = await browser.newContext();
      try {
        const escapes = await fence(context);
        const page = await context.newPage();
        await page.goto(loginUrl(next));
        await signInThroughForm(page, fixture.auditor.email);

        console.log(
          `[D-19] form, next=${JSON.stringify(next)}: landed ${page.url()}, escapes ${JSON.stringify(escapes)}`,
        );
        expect(escapes).toEqual([]);
        expect(new URL(page.url()).origin).toBe(ORIGIN);
        expect(new URL(page.url()).pathname).toBe('/');
      } finally {
        await context.close();
      }
    },
  );
});

describe('/login with a session the API confirms', () => {
  it('sends it to an internal destination', async () => {
    const context = await browser.newContext({ storageState: valid });
    try {
      const escapes = await fence(context);
      const page = await context.newPage();
      await page.goto(loginUrl('/documents?page=1'));
      await atRest(page);

      const landed = new URL(page.url());
      expect(`${landed.origin}${landed.pathname}${landed.search}`).toBe(
        `${ORIGIN}/documents?page=1`,
      );
      expect(escapes).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it.each(MALICIOUS)('keeps it on this origin, at home, for next=%j', async (next) => {
    const context = await browser.newContext({ storageState: valid });
    try {
      const escapes = await fence(context);
      const page = await context.newPage();
      await page.goto(loginUrl(next)).catch(() => undefined);
      await atRest(page);

      console.log(
        `[D-19] /login with a session, next=${JSON.stringify(next)}: landed ${page.url()}, escapes ${JSON.stringify(escapes)}`,
      );
      expect(escapes).toEqual([]);
      expect(new URL(page.url()).origin).toBe(ORIGIN);
      expect(new URL(page.url()).pathname).toBe('/');
    } finally {
      await context.close();
    }
  });

  it.each(['/\\evil.example', '/.//evil.example'])(
    'and /login/session-ended does the same for next=%j',
    async (next) => {
      const context = await browser.newContext({ storageState: valid });
      try {
        const escapes = await fence(context);
        const page = await context.newPage();
        await page
          .goto(`${WEB_URL}/login/session-ended?next=${encodeURIComponent(next)}`)
          .catch(() => undefined);
        await atRest(page);

        expect(escapes).toEqual([]);
        expect(new URL(page.url()).origin).toBe(ORIGIN);
        expect(new URL(page.url()).pathname).toBe('/');
      } finally {
        await context.close();
      }
    },
  );
});
