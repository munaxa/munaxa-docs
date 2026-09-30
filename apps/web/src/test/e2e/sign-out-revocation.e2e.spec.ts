import { existsSync } from 'node:fs';

import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { en } from '@edms/i18n';

import {
  API_PORT,
  type Fixture,
  type Servers,
  WEB_URL,
  cleanUpFixtures,
  emptyRedis,
  seedFixture,
  startServers,
  stopServers,
} from './servers';

/**
 * WEB-1: signing out through the web ends the session **at the API**, not only in the browser.
 *
 * The web client never refreshes; its refresh cookie exists to be revoked at sign-out. Until WEB-1
 * the sign-out named no tenant, the API — which reads no tenant from the host — refused it, the
 * refusal was swallowed, and a copy of the refresh token taken before sign-out went on exchanging
 * for new pairs, each good for a month. Clearing the browser's cookies hid that completely: every
 * screen looked signed out.
 *
 * So the assertion is made where the attacker would stand: the refresh token copied out of the
 * browser before sign-out, replayed afterwards **with its tenant** (a slug is not a secret), must be
 * refused.
 */

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const API = `http://127.0.0.1:${String(API_PORT)}/api/v1`;

let fixture: Fixture;
let servers: Servers | null = null;
let browser: Browser;

beforeAll(async () => {
  fixture = seedFixture();
  servers = await startServers(fixture);
  await emptyRedis(servers.redisUrl);
  browser = await chromium.launch(
    existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {},
  );
}, 240_000);

afterAll(async () => {
  await browser?.close();
  stopServers(servers);
  cleanUpFixtures();
});

async function replay(refreshToken: string, tenant: string): Promise<number> {
  const response = await fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, tenant }),
  });
  return response.status;
}

describe('signing out through the web', () => {
  it('revokes the refresh token at the API, so a copy taken before sign-out is refused', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${WEB_URL}/login`);
      await page.getByLabel(en.auth.emailLabel).fill(fixture.signer.email);
      await page.getByLabel(en.auth.passwordLabel).fill(fixture.password);
      await page.getByLabel(en.auth.organisationLabel).fill(fixture.slug);
      await page.getByRole('button', { name: en.auth.signIn }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

      const cookies = await context.cookies();
      const copied = cookies.find((cookie) => cookie.name === 'edms_rt')?.value;
      expect(copied, 'the browser holds no refresh cookie after signing in').toBeTruthy();
      // The tenant is kept beside it, httpOnly, for this sign-out.
      const tenant = cookies.find((cookie) => cookie.name === 'edms_tenant');
      expect(tenant?.value).toBe(fixture.slug);
      expect(tenant?.httpOnly).toBe(true);

      // Sign out the way a person does: the account menu, then "Sign out".
      await page.getByRole('button', { name: en.nav.account }).click();
      await page.getByText(en.auth.signOut, { exact: true }).click();
      await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 30_000 });

      const left = (await context.cookies()).filter((cookie) => cookie.name.startsWith('edms_'));
      expect(left.map((cookie) => cookie.name).filter((name) => name !== 'edms_locale')).toEqual(
        [],
      );

      // The attacker's copy, with the tenant named.
      expect(await replay(copied ?? '', fixture.slug)).toBe(401);
    } finally {
      await context.close();
    }
  });
});
