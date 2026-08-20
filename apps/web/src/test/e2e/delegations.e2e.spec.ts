import { existsSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * The delegations workspace, opened by a role the delegation matrix is actually about — Slice 20.
 *
 * ## Why this file exists
 *
 * `/delegations` filled its delegate picker from `/admin/users`, behind `user:manage`.
 * `08-permission-model.md` §6 marks `delegation:manage` **`own`** for the author and the approver,
 * and `role-seed.ts` seeds it to those two and to the document controller — none of which holds
 * `user:manage`. `adminGet` throws on a 403 and one rejection settles the whole `Promise.all`, so
 * the screen that exists to exercise an `own`-scoped permission rendered the route error boundary
 * for every role that holds it, and opened only for the tenant administrator, which is the one
 * column §6 does *not* mark `own`.
 *
 * Third instance of the same shape, after `/search` (Slice 10) and `/documents/:id/permissions`
 * (Slice 12), and it survived for the reason all three did: every end-to-end test in this
 * repository signed in as a fixture holding effectively the whole catalogue, and a suite of
 * superusers cannot notice a screen that depends on a permission it should not.
 *
 * ## Two sign-ins
 *
 * `auth.login` allows ten per five minutes per identity, and the shard comment in `ci.yml` tracks
 * the budget by browser sign-in. Each persona signs in once and the state is reused, which is also
 * what a person does. The API-level assertions share one token each rather than logging in again.
 */
describe('arranging cover, as the roles that may arrange it', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;

  beforeAll(async () => {
    fixture = seedFixture();
    servers = await startServers(fixture);
    browser = await chromium.launch(
      existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {},
    );
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  const url = () => `${WEB_URL}/delegations`;
  const api = () => `http://127.0.0.1:${String(API_PORT)}/api/v1`;

  /**
   * The document controller, holding `delegation:manage` and no `user:manage`.
   *
   * The fixture's own note says what it is for: *"the seeded document controller, plus the two
   * operational read keys the shipped migration grants it — and nothing else."* It is the persona
   * this defect locked out, and it stands here for the author and the approver too — all three hold
   * `delegation:manage` and none holds `user:manage`, which
   * `identity/presentation/directory-permissions.spec.ts` asserts against the seed by name.
   */
  describe('the document controller, which administers no people', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      context = await browser.newContext({
        storageState: await signInAndCapture(
          browser,
          WEB_URL,
          fixture.controller.email,
          fixture.password,
          fixture.slug,
        ),
        viewport: { width: 1440, height: 900 },
      });
      page = await context.newPage();
    }, 180_000);

    afterAll(async () => {
      await context?.close();
    });

    it('opens the workspace rather than the error boundary', async () => {
      /*
       * The assertion the defect would fail. Before this slice the controller got the route error
       * boundary here — no heading, no tabs, no table — while `/delegations` itself answered 200
       * for it. The list it was refused was never the one the screen needed.
       */
      await page.goto(url(), { waitUntil: 'networkidle' });

      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(/something went wrong/i);
      expect(body).not.toMatch(/do not have permission/i);
      expect(
        await page
          .getByRole('heading', { name: /delegations/i })
          .first()
          .isVisible(),
      ).toBe(true);
    });

    it('offers somebody to cover, resolved without any administrative read', async () => {
      /*
       * The picker, which is the half that needed the new route. Its options come from a projection
       * carrying an identifier and a label, on `delegation:manage` — so this asserts a *name* is on
       * offer rather than that the control merely exists. A `Combobox`, so the options live in a
       * portalled listbox that opens on click rather than as `<option>` children of the control.
       */
      await page.goto(url(), { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /request a delegation/i }).click();

      const delegate = page.getByRole('combobox', { name: /who will cover/i });
      await delegate.waitFor({ state: 'visible', timeout: 30_000 });
      await delegate.click();

      // Scoped to the open panel: other controls in the dialogue are native `<select>`s, so a
      // document-wide `option` query resolves to their hidden `<option>` children first.
      const options = page.getByRole('listbox').getByRole('option');
      await options.first().waitFor({ state: 'visible', timeout: 30_000 });
      const names = await options.allInnerTexts();

      expect(names.length, 'the delegate picker offered nobody to choose').toBeGreaterThan(0);
      expect(
        names.some((text) => /^[0-9a-f-]{36}$/i.test(text.trim())),
        'a bare identifier reached the picker',
      ).toBe(false);
      await page.keyboard.press('Escape');
    });
  });

  describe('the auditor, who arranges nobody’s cover', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      context = await browser.newContext({
        storageState: await signInAndCapture(
          browser,
          WEB_URL,
          fixture.auditor.email,
          fixture.password,
          fixture.slug,
        ),
        viewport: { width: 1440, height: 900 },
      });
      page = await context.newPage();
    }, 180_000);

    afterAll(async () => {
      await context?.close();
    });

    it('is refused the workspace, and told so rather than shown an empty one', async () => {
      // The boundary this slice must not have moved. The auditor reads everything in scope and
      // mutates nothing at any scope; a delegation is a mutation, and it holds no key for one.
      await page.goto(url(), { waitUntil: 'networkidle' });

      const body = await page.locator('body').innerText();
      expect(body).toMatch(/do not have permission/i);
      expect(await page.getByRole('button', { name: /request a delegation/i }).count()).toBe(0);
    });
  });

  /**
   * The API, which is where the guard actually is. Hiding a control is never the control.
   */
  describe('the boundaries the slice draws', () => {
    const DELEGATES = '/delegations/delegates?page=1&pageSize=100&sortDirection=asc';

    it('opens the delegate list to the controller and keeps the account records shut', async () => {
      const token = await bearerFor(fixture.controller.email);

      for (const [path, expected] of [
        [DELEGATES, 200],
        // The route the page used to read, and the reason it was the error boundary. Untouched.
        ['/admin/users?page=1&pageSize=100', 403],
        ['/admin/roles?page=1&pageSize=100', 403],
      ] as const) {
        const answer = await fetch(`${api()}${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(answer.status, `${path} answered unexpectedly for the controller`).toBe(expected);
      }
    });

    it('hands back an identifier and a name, and nothing an account record carries', async () => {
      const token = await bearerFor(fixture.controller.email);
      const answer = await fetch(`${api()}${DELEGATES}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await answer.json()) as { data: readonly Record<string, unknown>[] };

      expect(body.data.length).toBeGreaterThan(0);
      for (const person of body.data) {
        // Asserted as the exact key set rather than as a list of absences: a positive shape check
        // passes just as happily with `email` or `mfaEnrolled` added beside the two that belong.
        expect(Object.keys(person).sort()).toEqual(['displayName', 'id']);
      }
    });

    it('refuses the auditor the delegate list, which is where the page’s gate is mirrored', async () => {
      const token = await bearerFor(fixture.auditor.email);
      const refused = await fetch(`${api()}${DELEGATES}`, {
        headers: { authorization: `Bearer ${token}` },
      });

      // It holds no `delegation:manage`, so the route refuses it for the same reason the screen
      // does — and the screen's refusal is a courtesy over an endpoint that would refuse anyway.
      expect(refused.status).toBe(403);
    });
  });

  /** A bearer token for one of the fixture's people, through the real login endpoint. */
  const tokens = new Map<string, string>();
  async function bearerFor(email: string): Promise<string> {
    const cached = tokens.get(email);
    if (cached !== undefined) {
      return cached;
    }
    const login = await fetch(`${api()}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: fixture.password, tenant: fixture.slug }),
    });
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    tokens.set(email, token);
    return token;
  }
});
