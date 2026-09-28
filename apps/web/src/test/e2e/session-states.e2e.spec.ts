import { existsSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { en } from '@edms/i18n';

import {
  API_PORT,
  type Fixture,
  type Servers,
  type StorageState,
  WEB_URL,
  cleanUpFixtures,
  emptyRedis,
  restartApi,
  seedFixture,
  signInAndCapture,
  startServers,
  stopApi,
  stopServers,
} from './servers';

/**
 * A session the API refused, a session nobody could check, and a session that is fine — RC
 * validation, D-18.
 *
 * The workspace used to redirect to `/login` on *any* failure of `/auth/me`, and `/login` redirected
 * back on the mere presence of the cookie. With the API down, a browser holding a session bounced
 * between them 273 times and made 3 014 requests in ten seconds; a disabled user's browser did the
 * same. Nothing ever rendered and nothing ever stopped.
 *
 * So these tests count. A final URL of `/login` proves nothing about a loop that passes through
 * `/login` on every lap: what is asserted is the number of navigations and requests the browser made,
 * and that the count is *still* that number seconds later — the page has come to rest, rather than the
 * test having happened to look at the right moment. Everything is real: the built web server, the
 * built API, PostgreSQL, Redis, Chromium. The API outage is the API process killed and its port freed.
 */

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** How long a page must stay still to count as having come to rest. */
const SETTLE_MS = 3_000;

let fixture: Fixture;
let servers: Servers | null = null;
let browser: Browser;
/** The signer: an administrator whose session stays valid throughout. */
let valid: StorageState;
/** The auditor's session, captured before the account is disabled. */
let doomed: StorageState;

/**
 * What the browser did, from the moment a context is watched.
 *
 * `documents` is every main-frame document the browser requested — one per page load, plus one per
 * HTTP redirect hop, since each hop is its own request. It is the count D-18's loop inflated, and the
 * one asserted exactly. `navigations` is Playwright's `framenavigated`, which also fires for the
 * same-document history update Next makes after hydrating, so it reads two for one page load; it is
 * recorded, and bounded, but not asserted exactly.
 */
interface Traffic {
  documents: string[];
  navigations: string[];
  requests: number;
}

function watch(context: BrowserContext, page: Page): Traffic {
  const traffic: Traffic = { documents: [], navigations: [], requests: 0 };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      traffic.navigations.push(new URL(frame.url()).pathname);
    }
  });
  context.on('request', (request) => {
    traffic.requests += 1;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      traffic.documents.push(new URL(request.url()).pathname);
    }
  });
  return traffic;
}

/**
 * Waits until nothing has navigated or been requested for `SETTLE_MS`, and fails if that never
 * happens. A loop never settles, so this is what turns "it eventually stopped" into a failure.
 */
async function settled(traffic: Traffic, within = 30_000): Promise<Traffic> {
  const deadline = Date.now() + within;
  let last = { navigations: traffic.navigations.length, requests: traffic.requests };
  let stillSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = { navigations: traffic.navigations.length, requests: traffic.requests };
    if (now.navigations !== last.navigations || now.requests !== last.requests) {
      last = now;
      stillSince = Date.now();
    } else if (Date.now() - stillSince >= SETTLE_MS) {
      return {
        documents: [...traffic.documents],
        navigations: [...traffic.navigations],
        requests: traffic.requests,
      };
    }
  }
  throw new Error(
    `The page never came to rest: ${String(traffic.navigations.length)} navigations and ` +
      `${String(traffic.requests)} requests (${traffic.navigations.slice(0, 8).join(' → ')} …)`,
  );
}

/**
 * Every cookie in the context, unfiltered: asking for an `http://` URL's cookies would hide the
 * `Secure` ones the production build sets, and "no session cookie" would pass for the wrong reason.
 */
async function sessionCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === 'edms_at')?.value;
}

function tokenOf(state: StorageState): string {
  const token = state.cookies.find((cookie) => cookie.name === 'edms_at')?.value;
  if (!token) {
    throw new Error('The captured state holds no session cookie.');
  }
  return token;
}

/** An administration call as the signer, straight to the API. */
async function asAdministrator(path: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenOf(valid)}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${String(response.status)}: ${await response.text()}`);
  }
}

/** A line for the log, so a run leaves the measured counts behind as evidence. */
function report(name: string, traffic: Traffic): void {
  console.log(
    `[D-18] ${name}: ${String(traffic.documents.length)} document request(s) ` +
      `[${traffic.documents.join(' → ')}], ${String(traffic.navigations.length)} frame ` +
      `navigation(s), ${String(traffic.requests)} request(s) in all`,
  );
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
  doomed = await signInAndCapture(
    browser,
    WEB_URL,
    fixture.auditor.email,
    fixture.password,
    fixture.slug,
  );
}, 300_000);

afterAll(async () => {
  await browser?.close();
  stopServers(servers);
  cleanUpFixtures();
});

describe('a session the API confirms (D)', () => {
  it('opens the workspace in one navigation and keeps the cookie', async () => {
    const context = await browser.newContext({ storageState: valid });
    try {
      const page = await context.newPage();
      const traffic = watch(context, page);

      await page.goto(`${WEB_URL}/documents`);
      await expect
        .poll(() => page.getByRole('button', { name: en.nav.account }).isVisible())
        .toBe(true);
      const rest = await settled(traffic);
      report('valid session', rest);

      expect(new URL(page.url()).pathname).toBe('/documents');
      expect(rest.documents).toEqual(['/documents']);
      expect(rest.navigations.length).toBeLessThanOrEqual(2);
      expect(await sessionCookie(context)).toBe(tokenOf(valid));
    } finally {
      await context.close();
    }
  });
});

describe('a session the API refused (A)', () => {
  it('lands on sign-in once, with the cookie cleared, and stays there', async () => {
    await asAdministrator(`/admin/users/${fixture.auditor.id}/disable`);
    const context = await browser.newContext({ storageState: doomed });
    try {
      const page = await context.newPage();
      const traffic = watch(context, page);

      await page.goto(`${WEB_URL}/documents`);
      await page.getByLabel(en.auth.emailLabel).waitFor({ state: 'visible', timeout: 30_000 });
      const rest = await settled(traffic);
      report('refused session', rest);

      expect(new URL(page.url()).pathname).toBe('/login');
      // The workspace, the route that clears the cookie, the form — and nothing after it. The
      // defect was hundreds.
      expect(rest.documents).toEqual(['/documents', '/login/session-ended', '/login']);
      expect(rest.navigations.length).toBeLessThanOrEqual(4);
      expect(rest.requests).toBeLessThan(60);
      expect(await sessionCookie(context)).toBeUndefined();
      // Said why, rather than presenting a sign-in form nobody asked for.
      await expect.poll(() => page.getByText(en.auth.sessionExpired).isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('lets the same person sign in again once the account is re-enabled', async () => {
    await asAdministrator(`/admin/users/${fixture.auditor.id}/activate`);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${WEB_URL}/login`);
      await page.getByLabel(en.auth.emailLabel).fill(fixture.auditor.email);
      await page.getByLabel(en.auth.passwordLabel).fill(fixture.password);
      await page.getByLabel(en.auth.organisationLabel).fill(fixture.slug);
      await page.getByRole('button', { name: en.auth.signIn }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('button', { name: en.nav.account }).isVisible())
        .toBe(true);
      expect(await sessionCookie(context)).toBeDefined();
    } finally {
      await context.close();
    }
  });
});

describe('a stale cookie on the sign-in page (C)', () => {
  it('shows the form without redirecting, and a fresh sign-in replaces the cookie', async () => {
    // `doomed` still holds the token the API revoked when the account was disabled above.
    const context = await browser.newContext({ storageState: doomed });
    try {
      const page = await context.newPage();
      const traffic = watch(context, page);

      await page.goto(`${WEB_URL}/login`);
      await page.getByLabel(en.auth.emailLabel).waitFor({ state: 'visible', timeout: 30_000 });
      const rest = await settled(traffic);
      report('stale cookie on /login', rest);

      expect(rest.documents).toEqual(['/login']);
      expect(rest.navigations.length).toBeLessThanOrEqual(2);
      expect(rest.requests).toBeLessThan(60);

      await page.getByLabel(en.auth.emailLabel).fill(fixture.reader.email);
      await page.getByLabel(en.auth.passwordLabel).fill(fixture.password);
      await page.getByLabel(en.auth.organisationLabel).fill(fixture.slug);
      await page.getByRole('button', { name: en.auth.signIn }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('button', { name: en.nav.account }).isVisible())
        .toBe(true);
      const fresh = await sessionCookie(context);
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(tokenOf(doomed));
    } finally {
      await context.close();
    }
  });
});

describe('the API unavailable (B)', () => {
  it('says so, keeps the session, stops, and recovers in the same browser', async () => {
    const context = await browser.newContext({ storageState: valid });
    let down = false;
    try {
      const page = await context.newPage();
      // Opened while everything is up, so what follows is somebody mid-session.
      await page.goto(`${WEB_URL}/documents`);
      await expect
        .poll(() => page.getByRole('button', { name: en.nav.account }).isVisible())
        .toBe(true);

      if (servers === null) {
        throw new Error('No servers.');
      }
      stopApi(servers);
      down = true;

      const traffic = watch(context, page);
      await page.goto(`${WEB_URL}/documents`);
      await page
        .getByText(en.auth.serviceUnavailable)
        .waitFor({ state: 'visible', timeout: 30_000 });
      const rest = await settled(traffic);
      report('API down, workspace', rest);

      expect(new URL(page.url()).pathname).toBe('/documents');
      expect(rest.documents).toEqual(['/documents']);
      expect(rest.navigations.length).toBeLessThanOrEqual(2);
      expect(rest.requests).toBeLessThan(60);
      expect(await sessionCookie(context)).toBe(tokenOf(valid));

      // The sign-in page, with the same cookie and the API still down: the form, a sentence saying
      // why the session could not be checked, and no redirect in either direction.
      const loginTraffic = watch(context, page);
      await page.goto(`${WEB_URL}/login`);
      await page
        .getByText(en.auth.sessionUnverified)
        .waitFor({ state: 'visible', timeout: 30_000 });
      const loginRest = await settled(loginTraffic);
      report('API down, /login with a cookie', loginRest);
      expect(loginRest.documents).toEqual(['/login']);
      expect(loginRest.navigations.length).toBeLessThanOrEqual(2);
      expect(await sessionCookie(context)).toBe(tokenOf(valid));

      // Back to the workspace, then the API returns and the reader asks again.
      await page.goto(`${WEB_URL}/documents`);
      await page
        .getByText(en.auth.serviceUnavailable)
        .waitFor({ state: 'visible', timeout: 30_000 });
      servers = await restartApi(servers);
      down = false;

      await page.getByRole('button', { name: en.state.retry }).click();
      await expect
        .poll(() => page.getByRole('button', { name: en.nav.account }).isVisible(), {
          timeout: 30_000,
        })
        .toBe(true);
      expect(new URL(page.url()).pathname).toBe('/documents');
      expect(await sessionCookie(context)).toBe(tokenOf(valid));
    } finally {
      await context.close();
      // Whatever failed above, the next test gets an API.
      if (down && servers !== null) {
        servers = await restartApi(servers);
      }
    }
  }, 180_000);

  it('bounds a check against an API that accepts connections and never answers', async () => {
    if (servers === null) {
      throw new Error('No servers.');
    }
    const context = await browser.newContext({ storageState: valid });
    const pid = servers.api.pid;
    try {
      const page = await context.newPage();
      // Frozen, not gone: the port still accepts connections and nothing answers on them.
      process.kill(-(pid ?? 0), 'SIGSTOP');
      const traffic = watch(context, page);
      const started = Date.now();

      await page.goto(`${WEB_URL}/documents`, { timeout: 60_000 });
      await page
        .getByText(en.auth.serviceUnavailable)
        .waitFor({ state: 'visible', timeout: 60_000 });
      const elapsed = Date.now() - started;
      const rest = await settled(traffic);
      report(`API frozen, workspace after ${String(elapsed)} ms`, rest);

      expect(elapsed).toBeLessThan(30_000);
      expect(rest.documents).toEqual(['/documents']);
      expect(rest.navigations.length).toBeLessThanOrEqual(2);
      expect(await sessionCookie(context)).toBe(tokenOf(valid));
    } finally {
      process.kill(-(pid ?? 0), 'SIGCONT');
      await context.close();
    }
  }, 120_000);
});
