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
 * A person's own inbox, opened by the two roles that could not open one — Slice 21.
 *
 * ## Why this file exists
 *
 * `08-permission-model.md` §6 marks `notification:manage` **`own` in all eight columns** and calls
 * it "the only row in this matrix that is granted to everybody, and the only one where that is not
 * a mistake". `role-seed.ts` granted it to six: the document controller's and the auditor's
 * permission lists are named constants hoisted above the map, and both missed the row the other six
 * got inline.
 *
 * That was not a hidden menu item. Two producers resolve recipients by permission rather than by
 * role — `NotificationEventService.chainBroken` sends the audit-chain-broken alert to
 * `holdersOfPermission('audit:view')`, which is the administrator, the controller and the auditor,
 * and `retentionDue` sends to `holdersOfPermission('retention:manage')`, which the controller holds
 * — so the product wrote rows into two inboxes and then refused their owners `/v1/notifications`,
 * while `18-notification-architecture.md` §3 makes the in-app inbox the authoritative channel.
 * `MfaController` carries the same key, so neither role could enrol a second factor either.
 *
 * `role-seed.spec.ts` asserts the row and `notification-inbox-migration.integration.spec.ts`
 * asserts the backfill. What neither can say is that the screen opens, which is the claim every
 * read-dependency slice since Slice 10 has had to make in a real browser because a suite of
 * superuser fixtures is exactly what missed the last three.
 *
 * ## Three sign-ins
 *
 * `auth.login` allows ten per five minutes and `rate-limit.guard.ts` keys the `ip` dimension once
 * for the whole runner, so every `POST /auth/login` spends from the same ten — the `fetch` ones
 * below included. This file costs three: one browser sign-in, and two tokens, cached so each is
 * minted once. `ci.yml` tracks the shard budget.
 */
describe('the inbox every role has, and the tenant’s notification settings that only one does', () => {
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

  const api = () => `http://127.0.0.1:${String(API_PORT)}/api/v1`;

  /**
   * The auditor, which the fixture builds from `DEFAULT_ROLE_PERMISSIONS.AUDITOR` and nothing else.
   *
   * The least-privileged role that can sign in, and — because `chainBroken` resolves its recipients
   * as `holdersOfPermission('audit:view')` — one of the three the most serious compliance
   * notification in the product is delivered to.
   */
  describe('the auditor, which the audit-chain alert is addressed to', () => {
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

    it('opens the notification centre rather than being told it may not', async () => {
      /*
       * The assertion the defect would fail. `/notifications` gates on `notification:manage` and
       * rendered `AdminForbidden` for this role — "You do not have permission to do this." — on the
       * one screen `08 §6` says every column may open.
       */
      await page.goto(`${WEB_URL}/notifications`, { waitUntil: 'networkidle' });

      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(/do not have permission/i);
      expect(body).not.toMatch(/something went wrong/i);
      expect(
        await page
          .getByRole('heading', { name: /notifications/i })
          .first()
          .isVisible(),
      ).toBe(true);
    });

    it('is offered its own preferences, which is the other half of the key', async () => {
      // `/notifications/preferences` is fetched by the same server component and is what the row
      // means by "a person's own inbox and their own preferences". A screen that rendered the list
      // and no preference panel would mean the third read had been dropped rather than granted.
      await page.goto(`${WEB_URL}/notifications`, { waitUntil: 'networkidle' });

      const body = await page.locator('body').innerText();
      expect(body).toMatch(/preferences/i);
    });
  });

  describe('the boundaries the grant does not move', () => {
    it('opens the inbox, the count, and the authenticator to both roles', async () => {
      for (const email of [fixture.auditor.email, fixture.controller.email]) {
        const token = await bearerFor(email);

        for (const path of [
          '/notifications?page=1&pageSize=50',
          '/notifications/unread-count',
          '/notifications/preferences',
          // `MfaController` declares the same key, because it is the only existing permission
          // meaning "this person's own arrangements about their own account". Everybody who can
          // sign in must be able to secure their sign-in; these two could not.
          '/auth/mfa',
        ]) {
          const answer = await fetch(`${api()}${path}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(answer.status, `${path} must be open to ${email}`).toBe(200);
        }
      }
    });

    it('still refuses both the tenant’s notification configuration', async () => {
      /*
       * The distinction the whole slice rests on. `/v1/notifications` is the caller's own inbox,
       * scoped by absence — no route under it takes a recipient. `/v1/admin/notifications` edits the
       * tenant's templates and suppressions and is a different controller on `settings:manage`,
       * which `08 §6` marks `—` for both columns. Reading "notification:manage" as "administers
       * notifications" is the misreading this asserts against.
       */
      for (const email of [fixture.auditor.email, fixture.controller.email]) {
        const token = await bearerFor(email);

        for (const path of ['/admin/notifications/types', '/admin/notifications/templates']) {
          const refused = await fetch(`${api()}${path}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(refused.status, `${path} must still refuse ${email}`).toBe(403);
        }
      }
    });

    it('leaves the auditor unable to mutate anything of the tenant’s', async () => {
      // The row this file must not have moved. An inbox and an authenticator are the auditor's own;
      // a delegation and a permission entry are the tenant's, and it holds neither key.
      const token = await bearerFor(fixture.auditor.email);

      for (const path of [
        '/delegations?page=1&pageSize=50&direction=GIVEN',
        `/scopes/document/${fixture.documentId}/permissions`,
      ]) {
        const refused = await fetch(`${api()}${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(refused.status, `${path} must still refuse the auditor`).toBe(403);
      }
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
