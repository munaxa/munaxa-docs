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

const API = `http://127.0.0.1:${String(API_PORT)}/api/v1`;

describe('the library’s “Include subfolders” switch, in the running product', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let procedures: string;
  let archived: { id: string; title: string };
  let inRoot: string;

  async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const answer = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!answer.ok) {
      throw new Error(`${path} answered ${String(answer.status)}: ${await answer.text()}`);
    }
    return (await answer.json()) as T;
  }

  beforeAll(async () => {
    fixture = seedFixture();
    servers = await startServers(fixture);

    // Quality › Procedures › Archive, with one document two levels down: in the subtree of
    // Procedures, but not in Procedures itself.
    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fixture.signer.email,
        password: fixture.password,
        tenant: fixture.slug,
      }),
    });
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    const folder = (name: string, parentId: string) =>
      api<{ id: string }>(token, '/admin/folders', {
        method: 'POST',
        body: JSON.stringify({ libraryId: fixture.libraryId, parentId, name, inheritAcl: true }),
      });
    procedures = (await folder('Procedures', fixture.folderId)).id;
    const archive = (await folder('Archive', procedures)).id;
    const second = await api<{ id: string; title: string; version: number }>(
      token,
      `/documents/${fixture.approvalDocumentId}`,
    );
    await api(token, `/documents/${second.id}/move`, {
      method: 'POST',
      headers: { 'If-Match': `"${String(second.version)}"` },
      body: JSON.stringify({ folderId: archive }),
    });
    archived = { id: second.id, title: second.title };
    inRoot = (await api<{ title: string }>(token, `/documents/${fixture.documentId}`)).title;

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
  }, 240_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    stopServers(servers);
    cleanUpFixtures();
  });

  function toggle() {
    return page.getByRole('switch', { name: en.documents.list.includeSubfolders });
  }

  /**
   * Clicks the switch and waits for the navigation it causes to land.
   *
   * The switch navigates inside a transition, so the network can fall idle before the address bar
   * moves — waiting on idleness alone reads the page as it was *before* the click. The URL changing
   * is the event, and every click here changes it.
   */
  async function flip(): Promise<URL> {
    const before = page.url();
    await toggle().click();
    await page.waitForURL((url) => url.href !== before);
    await page.waitForLoadState('networkidle');
    return new URL(page.url());
  }

  async function mainText(): Promise<string> {
    return page.locator('main').innerText();
  }

  it('widens the selected folder to its subtree, and keeps the folder', async () => {
    await page.goto(`${WEB_URL}/documents?libraryId=${fixture.libraryId}&folderId=${procedures}`, {
      waitUntil: 'networkidle',
    });
    expect(await toggle().getAttribute('aria-checked')).toBe('false');
    expect(await mainText()).not.toContain(archived.title);

    const url = await flip();
    const body = await mainText();

    expect(url.searchParams.get('underFolderId')).toBe(procedures);
    expect(url.searchParams.get('folderId')).toBeNull();
    expect(url.searchParams.get('libraryId')).toBe(fixture.libraryId);
    expect(await toggle().getAttribute('aria-checked')).toBe('true');
    expect(body).toContain(archived.title);
    expect(body).not.toContain(inRoot);
  });

  it('narrows back to the folder itself when switched off', async () => {
    await page.goto(
      `${WEB_URL}/documents?libraryId=${fixture.libraryId}&underFolderId=${procedures}`,
      { waitUntil: 'networkidle' },
    );
    expect(await toggle().getAttribute('aria-checked')).toBe('true');

    const url = await flip();
    const body = await mainText();

    expect(url.searchParams.get('folderId')).toBe(procedures);
    expect(url.searchParams.get('underFolderId')).toBeNull();
    expect(url.searchParams.get('libraryId')).toBe(fixture.libraryId);
    expect(await toggle().getAttribute('aria-checked')).toBe('false');
    expect(body).not.toContain(archived.title);
    expect(body).not.toContain(inRoot);
  });
  it('keeps the other filters, and one step back is the folder again', async () => {
    const word = archived.title.split(' ')[0] ?? '';
    const start = `${WEB_URL}/documents?libraryId=${fixture.libraryId}&folderId=${procedures}&search=${encodeURIComponent(word)}`;
    await page.goto(start, { waitUntil: 'networkidle' });

    const url = await flip();

    expect(url.searchParams.get('search')).toBe(word);
    expect(url.searchParams.get('libraryId')).toBe(fixture.libraryId);
    expect(url.searchParams.get('underFolderId')).toBe(procedures);
    expect(await mainText()).toContain(archived.title);

    // One click, one history entry: Back is the folder as it was, not a half-applied change.
    await page.goBack({ waitUntil: 'networkidle' });
    const back = new URL(page.url());
    expect(back.searchParams.get('folderId')).toBe(procedures);
    expect(back.searchParams.get('underFolderId')).toBeNull();
    expect(back.searchParams.get('search')).toBe(word);
    // A history step renders from the router's cache inside a transition, so the switch follows
    // the address bar rather than arriving with it. Polled for the state, not slept for.
    await expect
      .poll(() => toggle().getAttribute('aria-checked'), { timeout: 10_000 })
      .toBe('false');
    expect(await mainText()).not.toContain(archived.title);
  });
});
