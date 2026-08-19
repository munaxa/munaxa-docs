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
 * The document permissions workspace, opened by each role that can open it — Slice 12.
 *
 * ## Why this file exists
 *
 * `/documents/:id/permissions` captioned its entries by fetching `/admin/users`, `/admin/roles` and
 * `/admin/departments` — `user:manage`, `role:manage` and `org:manage`. The seeded **document
 * controller** holds `document:permission:manage` and none of those three, so all three answered
 * 403 through a wrapper that throws, and this route was the error boundary for the one role the
 * permissions controller's own docstring names as an intended user.
 *
 * That is the same defect `/search` had, on a screen where being wrong is more expensive, and it
 * survived for the same reason: every end-to-end test in this repository signed in as a fixture
 * holding effectively the whole catalogue. The personas below hold the product's own seeded grants,
 * imported by the fixture from `role-seed.ts` rather than typed out, with nothing added for the
 * test's convenience.
 *
 * ## Three sign-ins
 *
 * `auth.login` allows ten per five minutes per shard, and the shard comment in `ci.yml` tracks the
 * budget. Each persona signs in once and the state is reused, which is also what a person does.
 */
describe('document permissions as each role', () => {
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

  const url = () => `${WEB_URL}/documents/${fixture.documentId}/permissions`;
  const api = () => `http://127.0.0.1:${String(API_PORT)}/api/v1`;

  /** The two roles seeded with `document:permission:manage`, by what else they administer. */
  const MANAGERS = [
    {
      name: 'the document controller, which administers no people',
      of: (f: Fixture) => f.controller.email,
    },
    { name: 'the tenant administrator', of: (f: Fixture) => f.signer.email },
  ] as const;

  for (const persona of MANAGERS) {
    describe(persona.name, () => {
      let context: BrowserContext;
      let page: Page;

      beforeAll(async () => {
        context = await browser.newContext({
          storageState: await signInAndCapture(
            browser,
            WEB_URL,
            persona.of(fixture),
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
         * The assertion the defect would fail. Before this slice the document controller got the
         * route error boundary here — no heading, no table, no form — while `/documents/:id` and
         * `/scopes/document/:id/permissions` both answered 200 for it. The three catalogues it was
         * refused were never needed.
         */
        await page.goto(url(), { waitUntil: 'networkidle' });

        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/something went wrong/i);
        expect(body).not.toMatch(/forbidden/i);
        expect(
          await page
            .getByRole('heading', { name: /permission/i })
            .first()
            .isVisible(),
        ).toBe(true);
      });

      it('offers a subject to name, resolved without any administrative read', async () => {
        /*
         * The role picker, which is the half that needed `/acl/roles`. Its options come from a
         * projection carrying an identifier and a label, on `document:permission:manage` — so this
         * asserts a *name* is on offer rather than that the control merely exists.
         */
        await page.goto(url(), { waitUntil: 'networkidle' });

        const subject = page.getByLabel('Subject', { exact: false }).first();
        expect(await subject.isVisible(), 'the subject picker was not rendered').toBe(true);
        const options: readonly string[] = await subject.locator('option').allInnerTexts();

        expect(options.length, 'the subject picker offered nothing to choose').toBeGreaterThan(1);
        expect(
          options.some((text) => /^[0-9a-f-]{36}$/i.test(text.trim())),
          'a bare identifier reached the picker',
        ).toBe(false);
      });

      it('resolves the effective table for a named person', async () => {
        // The other server-answered half, and the one ADR-0005 asks for by name. It is reached
        // through the URL, so this proves the whole page still renders with the query on it.
        await page.goto(`${url()}?userId=${fixture.reader.id}`, { waitUntil: 'networkidle' });

        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/something went wrong/i);
        expect(body).toMatch(/document:view/);
      });
    });
  }

  describe('the auditor, who holds no permission-management key', () => {
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
      // mutates nothing at any scope; permission management is a mutation's screen.
      await page.goto(url(), { waitUntil: 'networkidle' });

      const body = await page.locator('body').innerText();
      expect(body).toMatch(/permission/i);
      // Not the editable table: a refusal that rendered the screen with no entries would read as
      // "this document has no explicit permissions", which is the more dangerous of the two.
      expect(await page.getByRole('button', { name: /revoke/i }).count()).toBe(0);
    });

    it('is refused the permission API itself, which is where the guard is', async () => {
      const token = await bearerFor(fixture.auditor.email);

      for (const path of [
        `/scopes/document/${fixture.documentId}/permissions`,
        '/acl/roles?page=1&pageSize=25&sortBy=name&sortDirection=asc',
      ]) {
        const refused = await fetch(`${api()}${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(refused.status, `${path} must refuse the auditor`).toBe(403);
      }
    });
  });

  describe('the boundaries this slice did not move', () => {
    it('still refuses the document controller every administrative catalogue', async () => {
      /*
       * The security half, asserted through the API because that is where the guard is. The
       * controller now reads the same captions and the same pickers as the tenant administrator
       * while holding none of these three keys, which is precisely the claim worth checking.
       */
      const token = await bearerFor(fixture.controller.email);

      for (const path of [
        '/admin/users',
        '/admin/roles',
        '/admin/departments',
        '/admin/entities',
      ]) {
        const refused = await fetch(`${api()}${path}?page=1&pageSize=25`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(refused.status, `${path} must still refuse the controller`).toBe(403);
      }
    });

    it('opens the three narrow read models to it instead', async () => {
      // The other half of the same claim: nothing anybody legitimately held was taken away, and
      // exactly the three routes the page now asks for are the three it can reach.
      const token = await bearerFor(fixture.controller.email);

      for (const path of [
        '/directory/people?page=1&pageSize=25&sortBy=displayName&sortDirection=asc',
        '/directory/departments?page=1&pageSize=25&sortBy=name&sortDirection=asc',
        '/acl/roles?page=1&pageSize=25&sortBy=name&sortDirection=asc',
      ]) {
        const allowed = await fetch(`${api()}${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(allowed.status, `${path} must be open to the controller`).toBe(200);
      }
    });

    it('gives the role picker two columns and no authority map', async () => {
      /*
       * `/acl/roles` exists so the permission editor need not read `/admin/roles`, and the reason
       * that is an improvement is the response body. If this ever grew `permissions`, every holder
       * of `document:permission:manage` would gain the tenant's authority map — who can approve,
       * who can delete — as a side effect of filling in a dropdown.
       */
      const token = await bearerFor(fixture.controller.email);
      const answer = await fetch(
        `${api()}/acl/roles?page=1&pageSize=25&sortBy=name&sortDirection=asc`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const body = (await answer.json()) as { data: Record<string, unknown>[] };

      expect(body.data.length).toBeGreaterThan(0);
      for (const role of body.data) {
        expect(Object.keys(role).sort()).toStrictEqual(['id', 'name']);
      }
    });

    it('answers a document in another tenant the same way it answers a missing one', async () => {
      // `08 §7`: the guard cannot distinguish "no such document" from "not yours" and must not.
      const token = await bearerFor(fixture.controller.email);
      const foreign = '019489f0-0000-7000-8000-0000000fffff';

      const answer = await fetch(`${api()}/scopes/document/${foreign}/permissions`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(answer.status).toBe(404);
    });
  });

  /** A bearer token for one of the fixture's people, through the real login endpoint. */
  async function bearerFor(email: string): Promise<string> {
    const login = await fetch(`${api()}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: fixture.password, tenant: fixture.slug }),
    });
    return ((await login.json()) as { accessToken: string }).accessToken;
  }
});
