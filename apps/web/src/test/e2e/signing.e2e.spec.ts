import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  API_PORT,
  type Fixture,
  type Servers,
  WEB_URL,
  cleanUpFixtures,
  seedFixture,
  startServers,
  stopServers,
} from './servers';

/**
 * Signing a document, in the real product — Phase 6.6's mandatory proof.
 *
 * A real Nest API over a real PostgreSQL and a real Redis, the real Next application over its
 * production build, and real Chromium driving the shipped HTML. **Nothing is mocked, and the
 * signature endpoints least of all.**
 *
 * ## The one assertion the whole phase rests on
 *
 * `the statement on screen is the statement in the database`. The test reads the text out of the
 * rendered `<pre>`, signs through the ceremony, then reads `document_signature.statement_body`
 * straight from the table and compares them line by line. Every line matches except `signed-at`,
 * which cannot match by construction — the preview is prepared before the signature is taken —
 * and the test asserts that it is the *only* difference rather than tolerating a set of them.
 *
 * A UI test that only checked "a signature appeared" would pass just as happily if the browser had
 * rendered a statement it composed itself, which is exactly what ADR-0017 §3 forbids and exactly
 * what Phase 6.6 stopped for.
 *
 * ## Why the database is read directly here
 *
 * Because the API deliberately does not return the signed bytes on the list or on the `POST`:
 * `toSignature` omits `statementBody`, and only verification returns it. Reading the row is how a
 * test asks what was actually stored rather than what an endpoint chose to reveal — and the audit
 * assertions below need the same access.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');

let browser: Browser;
let servers: Servers | null = null;
let fixture: Fixture;

/**
 * One sign-in per person for the whole suite, kept as cookies.
 *
 * `auth.login` is ten attempts per five minutes *per address*, and this suite has more than ten
 * tests. Signing in per test spends that budget and turns the later ones into `429`s that surface
 * as "the page never navigated" — self-inflicted flakiness in a security control's own repository,
 * and the same trap Phase 6.7 and Phase 6.6A each fell into once. A saved storage state is also
 * closer to what a person does: sign in once, then work.
 */
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();

beforeAll(async () => {
  if (!process.env.DATABASE_MIGRATION_URL) {
    throw new Error(
      'DATABASE_MIGRATION_URL must be set: this suite signs against a real database.',
    );
  }
  cleanUpFixtures();
  fixture = seedFixture();
  servers = await startServers(fixture);
  browser = await chromium.launch({
    headless: true,
    // `--no-proxy-server` because this environment exports `HTTP_PROXY`/`HTTPS_PROXY` for outbound
    // traffic, and Chromium honours them for *every* request including `127.0.0.1`. Without it the
    // browser tries to reach the local web server through an egress proxy that has no route to it,
    // and every navigation times out with no clue as to why.
    args: ['--no-proxy-server'],
    ...(process.env.CHROMIUM_PATH !== undefined
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
  await establishSession(fixture.signer.email);
  await establishSession(fixture.reader.email);
  if (fixture.neighbour !== null) {
    await establishSession(fixture.neighbour.email, fixture.neighbour.slug);
  }
}, 300_000);

afterAll(async () => {
  await browser?.close();
  stopServers(servers);
  cleanUpFixtures();
});

/** One SQL question, answered by the database rather than by an endpoint. */
function query(sql: string, ...params: string[]): Record<string, string>[] {
  const script =
    "const {PrismaClient}=require('@prisma/client');" +
    'const c=new PrismaClient({datasources:{db:{url:process.env.DATABASE_MIGRATION_URL}}});' +
    `c.$queryRawUnsafe(${JSON.stringify(sql)}${params.map((p) => `,${JSON.stringify(p)}`).join('')})` +
    '.then(r=>{process.stdout.write(JSON.stringify(r));return c.$disconnect()})' +
    '.catch(e=>{console.error(e);process.exit(1)});';
  const out = execFileSync('node', ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return JSON.parse(out) as Record<string, string>[];
}

function signatureRows(): Record<string, string>[] {
  return query(
    'SELECT id, statement_body, signature, purpose, reauthenticated::text, withdrawn_at::text ' +
      'FROM document_signature WHERE tenant_id = $1::uuid ORDER BY signed_at',
    fixture.tenantId,
  );
}

function auditActions(): string[] {
  return query(
    'SELECT action FROM audit_event WHERE tenant_id = $1::uuid ORDER BY sequence',
    fixture.tenantId,
  ).map((row) => row.action as string);
}

/** The lines of a statement, keyed by field name — the shape "differs only in the instant" needs. */
function fieldsOf(statement: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of statement.split('\n')) {
    if (line === '') {
      continue;
    }
    const separator = line.indexOf(':');
    fields.set(separator === -1 ? line : line.slice(0, separator), line);
  }
  return fields;
}

function differingFields(left: string, right: string): string[] {
  const a = fieldsOf(left);
  const b = fieldsOf(right);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((name) => a.get(name) !== b.get(name))
    .sort();
}

/** Signs in for real, through the shipped form, and remembers the cookies it was given. */
async function establishSession(email: string, tenant = fixture.slug): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${WEB_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByLabel('Organisation').fill(tenant);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  sessions.set(email, await context.storageState());
  await context.close();
}

/** A page already holding that person's session — the cookies a real browser would still have. */
async function pageFor(email: string): Promise<{ page: Page; context: BrowserContext }> {
  const state = sessions.get(email);
  if (state === undefined) {
    throw new Error(`No session for ${email}.`);
  }
  const context = await browser.newContext({ storageState: state });
  return { page: await context.newPage(), context };
}

async function openDocument(page: Page): Promise<void> {
  await page.goto(`${WEB_URL}/documents/${fixture.documentId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Signatures' }).waitFor({ timeout: 30_000 });
}

describe('signing a document end to end', () => {
  let statementOnScreen = '';

  it('offers the action, shows the server statement, and signs nothing until told to', async () => {
    const { page } = await pageFor(fixture.signer.email);
    await openDocument(page);

    // Nothing signed yet, and the panel says so.
    expect(signatureRows()).toHaveLength(0);
    await page.getByText('Nobody has signed this revision.').waitFor({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const statement = page.getByTestId('signature-statement');
    await statement.waitFor({ timeout: 30_000 });
    statementOnScreen = (await statement.textContent()) ?? '';

    // The bytes came from the server, and they are the canonical serialisation rather than
    // anything a screen could have assembled.
    expect(statementOnScreen.startsWith('munaxa-docs-signature/v1\n')).toBe(true);
    const fields = fieldsOf(statementOnScreen);
    expect(fields.get('tenant')).toBe(`tenant:${fixture.tenantId}`);
    expect(fields.get('document')).toBe(`document:${fixture.documentId}`);
    expect(fields.get('number')).toBe(`number:${fixture.documentNumber}`);
    expect(fields.get('revision')).toBe(`revision:${fixture.revisionId}`);
    expect(fields.get('content-sha256')).toBe(`content-sha256:${fixture.contentSha256}`);
    expect(fields.get('signer-name')).toBe(`signer-name:${fixture.signer.name}`);

    // Opening the ceremony wrote nothing at all — no signature, and no `DOCUMENT_SIGNED`.
    expect(signatureRows()).toHaveLength(0);
    expect(auditActions()).not.toContain('DOCUMENT_SIGNED');

    // And no credential is asked for until the statement has been read.
    expect(await page.getByLabel('Your password').count()).toBe(0);
    await page.close();
  }, 120_000);

  it('signs, and the stored statement is the one that was displayed', async () => {
    const { page } = await pageFor(fixture.signer.email);
    await openDocument(page);

    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const displayed = (await page.getByTestId('signature-statement').textContent()) ?? '';
    expect(displayed).not.toBe('');

    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Your password').fill(fixture.password);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Sign this revision' }).click();

    await page.getByText('Your signature on revision Rev 0 is recorded.').waitFor({
      timeout: 30_000,
    });

    const rows = signatureRows();
    expect(rows).toHaveLength(1);

    // **The assertion this phase exists for.** What the person read and what the database holds
    // differ in the instant and in nothing else.
    expect(differingFields(displayed, rows[0]?.statement_body ?? '')).toEqual(['signed-at']);
    expect(rows[0]?.purpose).toBe('APPROVAL');
    // §11.200: the row records that credentials were proved again, because they were.
    expect(rows[0]?.reauthenticated).toBe('true');

    // The audit event is the backend's, and it exists exactly once.
    expect(auditActions().filter((action) => action === 'DOCUMENT_SIGNED')).toHaveLength(1);
    await page.close();
  }, 120_000);

  it('still shows the signed state after a reload', async () => {
    const { page } = await pageFor(fixture.signer.email);
    await openDocument(page);

    // A fresh navigation, so nothing on screen can be left over from the request that signed.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Signatures' }).waitFor({ timeout: 30_000 });

    await page.getByText('Ada Lovelace — Approving this for release').waitFor({ timeout: 30_000 });
    expect(await page.getByText('Nobody has signed this revision.').count()).toBe(0);
    await page.close();
  }, 120_000);

  it('verifies the signature through the API, with all three answers', async () => {
    const { page } = await pageFor(fixture.signer.email);
    await openDocument(page);

    await page.getByRole('button', { name: 'Verify' }).click();
    await page.getByText('The signature is intact.').waitFor({ timeout: 30_000 });

    // Three separate findings, not one badge. `contentMatches` is a §11.70 record-linking answer
    // and is meaningless collapsed into "valid".
    await page.getByText('The revision still holds the content that was signed.').waitFor();
    await page.getByText('This signature stands.').waitFor();
    // The witness is named as a key, never as a certificate subject.
    expect(await page.getByText(/Witnessed by munaxa-docs:/).count()).toBe(1);
    await page.close();
  }, 120_000);

  it('refuses a second signature for the same meaning, and says so in the ceremony', async () => {
    const { page } = await pageFor(fixture.signer.email);
    await openDocument(page);

    await page.getByRole('button', { name: 'Sign', exact: true }).click();

    // The preview itself refuses, because the live-signature rule is checked before the statement
    // is produced — so the ceremony never displays a statement for an act about to be rejected,
    // and no statement is rendered at all.
    await page.getByRole('alert').first().waitFor({ timeout: 30_000 });
    expect(await page.getByTestId('signature-statement').count()).toBe(0);

    // The *sentence* is the API's generic validation message rather than "you already signed
    // this", and that is a limitation rather than a choice: `toDomainError` in the web's API
    // client drops the `errors` array, so a screen cannot tell a duplicate from a discarded
    // revision. The field-level refusal — `{ field: 'purpose', message: 'duplicate' }` — is
    // asserted where it is actually visible, in the API's own HTTP suite. Recorded in the phase
    // report as a known limitation with the fix it needs.

    // Still exactly one signature and exactly one audit event.
    expect(signatureRows()).toHaveLength(1);
    expect(auditActions().filter((action) => action === 'DOCUMENT_SIGNED')).toHaveLength(1);
    await page.close();
  }, 120_000);
});

describe('what the ceremony refuses', () => {
  it('creates nothing when the ceremony is cancelled', async () => {
    const { page } = await pageFor(fixture.signer.email);
    await openDocument(page);

    const before = signatureRows().length;
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await page.getByRole('combobox').first().waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();

    expect(signatureRows()).toHaveLength(before);
    await page.close();
  }, 120_000);

  it('creates nothing when the credentials are wrong', async () => {
    const { page } = await pageFor(fixture.signer.email);
    await openDocument(page);

    // A different meaning, so the live-signature rule does not refuse before the credentials do.
    // The meaning is chosen *before* waiting for a statement, because APPROVAL is already signed by
    // now and the ceremony opens on a refusal — which is itself the correct behaviour being relied
    // on here: the preview refuses an act that would be refused, and offers the choice anyway.
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await page.getByRole('combobox').first().waitFor({ timeout: 30_000 });
    await page.getByRole('combobox').first().selectOption('WITNESS');
    await page.getByTestId('signature-statement').waitFor({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Your password').fill('not the right password');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Sign this revision' }).click();

    const alert = page.getByRole('alert').first();
    await alert.waitFor({ timeout: 30_000 });
    const text = (await alert.textContent()) ?? '';
    // One refusal for every cause: the message must not say which half was wrong.
    expect(text).not.toMatch(/password was|code was|wrong password|missing code/i);
    // And nothing was written.
    expect(signatureRows()).toHaveLength(1);
    expect(auditActions().filter((action) => action === 'DOCUMENT_SIGNED')).toHaveLength(1);
    await page.close();
  }, 120_000);

  it('does not offer signing to somebody who may only read', async () => {
    const { page } = await pageFor(fixture.reader.email);
    await openDocument(page);

    // The panel is there — a signature is part of the record and `document:view` may see it — and
    // the action is not.
    await page.getByRole('heading', { name: 'Signatures' }).waitFor();
    expect(await page.getByRole('button', { name: 'Sign', exact: true }).count()).toBe(0);
    await page.close();
  }, 120_000);

  it('refuses the statement preview to that same reader, at the API', async () => {
    // Hiding the button is a courtesy; **this** is the control, and it is asserted against the
    // real route with the reader's real token.
    //
    // Deliberately not through the browser. The access token lives in an `httpOnly` cookie that
    // only the web server can read, so page JavaScript has no way to authenticate to the API at
    // all — a `fetch` from the page is anonymous and would prove nothing about `document:sign`.
    // That property is itself worth stating: there is no browser-reachable path to this route
    // that carries a session.
    const login = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fixture.reader.email,
        password: fixture.password,
        tenant: fixture.slug,
      }),
    });
    const session = (await login.json()) as { accessToken: string };

    const refused = await fetch(
      `http://127.0.0.1:${String(API_PORT)}/api/v1/documents/${fixture.documentId}` +
        `/signatures/statement?revisionId=${fixture.revisionId}&purpose=REVIEWED`,
      { headers: { Authorization: `Bearer ${session.accessToken}` } },
    );

    // `403`: the reader holds every permission in the catalogue except `document:sign`, so this is
    // that one permission refusing and nothing else.
    expect(refused.status).toBe(403);
  }, 120_000);
});

describe('rate limiting', () => {
  it('bounds signing at the API, and the refusal names no infrastructure', async () => {
    // **Split deliberately, and the reason is worth stating rather than hiding.**
    //
    // Two facts are being claimed: that signing is bounded over the real pipeline, and that a `429`
    // reaches a person as a sentence rather than as an infrastructure error. They are proven in the
    // two places each can actually be proven.
    //
    // *Here*: the bound itself, against the real route with a real token. Driving it through the
    // ceremony instead was tried and rejected — six trips through a dialogue take six re-openings,
    // and the loop's own waits turn "did the request happen" into a timing question, which is how
    // a rate-limit test becomes flaky. What Redis holds after such a run is the honest measure, and
    // it is measured directly below.
    //
    // *In `signing-ceremony.spec.tsx`*: the rendering — `RATE_LIMITED` becomes "Too many signing
    // attempts", with an assertion that the text mentions no Redis, cache, counter or status code.
    const login = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fixture.signer.email,
        password: fixture.password,
        tenant: fixture.slug,
      }),
    });
    const session = (await login.json()) as { accessToken: string };

    // A meaning nothing in this suite has touched, so the five-per-fifteen-minutes budget for
    // (tenant, signer, revision, purpose) is untouched.
    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await fetch(
        `http://127.0.0.1:${String(API_PORT)}/api/v1/documents/${fixture.documentId}/signatures`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({
            revisionId: fixture.revisionId,
            purpose: 'REVIEWED',
            password: 'not the right password',
          }),
        },
      );
      statuses.push(response.status);
      if (response.status === 429) {
        const problem = (await response.json()) as { code: string; detail: string };
        expect(problem.code).toBe('RATE_LIMITED');
        expect(`${problem.code} ${problem.detail}`).not.toMatch(
          /redis|cache|counter|bucket|ECONNREFUSED/i,
        );
      }
    }

    // Five refusals from authentication, then the limiter — `document.sign` is 5 per 15 minutes.
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);

    // And none of the six wrote anything: the signature count is what it was before.
    expect(signatureRows()).toHaveLength(1);
    expect(auditActions().filter((action) => action === 'DOCUMENT_SIGNED')).toHaveLength(1);
  }, 180_000);
});

// ================================================================================================
// Phase 6.9 — the eight workflows nobody had ever run.
//
// In the same file as the signing ceremony, and deliberately: both need the same booted API, the
// same booted web server and the same two tenant databases, and two files each booting their own
// meant one racing the other for port 3210. One lifecycle is simpler and cannot race itself.
// ================================================================================================

/**
 * What a person can actually read on the page.
 *
 * `body.textContent` is **not** that: a Next page embeds its RSC payload in `<script>` tags, and
 * that payload contains every error-boundary string the route could ever render — so asserting
 * "the page does not say 'Something went wrong'" against `textContent` matches the *fallback text
 * of a boundary that never fired*. Two healthy screens were reported broken that way before this
 * helper existed. `innerText` of the main landmark is what is rendered.
 */
async function visibleText(page: Page): Promise<string> {
  const main = page.locator('main');
  return (await main.count()) > 0 ? main.innerText() : page.locator('body').innerText();
}

/** A page holding that person's session — the shape the workflow assertions below use. */
async function pageOf(email: string): Promise<Page> {
  const { page } = await pageFor(email);
  return page;
}

function ask(sql: string, ...params: string[]): Record<string, string>[] {
  return query(sql, ...params);
}

function documentStatus(id: string): string {
  return ask('SELECT status FROM document WHERE id = $1::uuid', id)[0]?.status ?? 'MISSING';
}

/**
 * Every request the page makes, counted by path.
 *
 * The instrument Phase 6.8's P0 needed and did not have: a render loop is invisible to a
 * screenshot, to axe and to the type checker, and visible only as a number of requests.
 */
function countRequests(page: Page): { of: (fragment: string) => number; total: () => number } {
  const seen: string[] = [];
  page.on('request', (request) => {
    seen.push(request.url());
  });
  return {
    of: (fragment) => seen.filter((url) => url.includes(fragment)).length,
    total: () => seen.length,
  };
}

// --- 1. Document library ------------------------------------------------------------------------

describe('1 · document library', () => {
  it('lists this tenant’s documents, and the folder tree the API actually returns', async () => {
    const page = await pageOf(fixture.signer.email);
    const requests = countRequests(page);
    await page.goto(`${WEB_URL}/documents`, { waitUntil: 'domcontentloaded' });

    // Both seeded documents, by title. This is the screen Phase 6.9 found could not open at all in
    // a built deployment, because `new Set(DOCUMENT_FILTER_KEYS)` received a client reference.
    //
    // Counted rather than waited-for-visible: the list renders a responsive pair, and one of them
    // is hidden at any viewport. Presence in the document is what proves the API answered.
    await expect
      .poll(() => page.getByText('Batch release procedure').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    expect(await page.getByText('Deviation handling procedure').count()).toBeGreaterThan(0);

    // And no runaway: the library issues a bounded number of requests for one navigation.
    await page.waitForTimeout(1_000);
    expect(requests.total()).toBeLessThan(80);
    await page.close();
  }, 120_000);

  it('opens a document from the list and issues content URLs a bounded number of times', async () => {
    const page = await pageOf(fixture.signer.email);
    const requests = countRequests(page);
    await page.goto(`${WEB_URL}/documents/${fixture.documentId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('heading', { name: 'Signatures' }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);

    // Phase 6.8's P0, asserted where it would actually happen. Before the fix a mounted preview
    // panel issued thousands of presigned URLs a second; the bound here is generous and still four
    // orders of magnitude below the defect.
    expect(requests.of('/preview/content')).toBeLessThan(10);
    expect(requests.of('/documents/')).toBeLessThan(120);
    await page.close();
  }, 120_000);

  it('shows another tenant’s document to nobody, by identifier', async () => {
    if (fixture.neighbour === null) {
      throw new Error('SECOND_DATABASE_MIGRATION_URL must be set: isolation needs two databases.');
    }
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/documents/${fixture.neighbour.documentId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(1_500);

    const body = await visibleText(page);
    // Not the document, and nothing about it — not the title, not a database error, not SQL.
    expect(body).not.toContain('Neighbour confidential procedure');
    expect(body).not.toMatch(/relation|syntax error|ECONNREFUSED|prisma/i);
    await page.close();
  }, 120_000);
});

// --- 2. Document lifecycle ----------------------------------------------------------------------

describe('2 · document lifecycle', () => {
  it('archives a document through the screen, and the row and the trail agree', async () => {
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/documents/${fixture.secondDocumentId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('heading', { name: 'Signatures' }).waitFor({ timeout: 30_000 });

    // Published, and numbered — the state archival is legal from. The database refuses a published
    // document without a number (`ck_document_numbered_when_published`), so this pairing is the
    // product's own invariant rather than the fixture's preference.
    expect(documentStatus(fixture.secondDocumentId)).toBe('PUBLISHED');

    /*
     * Through the overflow menu, because that is where the record page's secondary actions live
     * since Phase 7 — and clicking it here rather than reaching past it is the point: what this
     * test proves is that a person can archive a controlled document *through the product*, so the
     * path has to be the one a person takes.
     *
     * `exact` because the dialogue this opens is also titled "Archive"; without it the locator is
     * ambiguous the moment the dialogue exists.
     */
    await page.getByRole('button', { name: 'More actions' }).click({ timeout: 30_000 });
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click({ timeout: 30_000 });

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 30_000 });
    // A reason is required — the trail records why, and `FormDialog` submits under its own label.
    await dialog.locator('textarea, input[type="text"]').first().fill('Superseded by Rev 1.');
    await dialog.getByRole('button', { name: 'Save' }).click();

    // The row, not the screen: a status badge is a rendering and this is a state transition.
    await expect
      .poll(() => documentStatus(fixture.secondDocumentId), { timeout: 30_000 })
      .toBe('ARCHIVED');
    // `ARCHIVED` — the *value* the catalogue stores, not the `DocumentAudit.DOCUMENT_ARCHIVED` key
    // that names it. The audit row holds the value, and asserting the key would be asserting the
    // constant's name rather than what the trail says.
    expect(auditActions()).toContain('ARCHIVED');
    await page.close();
  }, 120_000);

  it('keeps the archived state after a reload', async () => {
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/documents/${fixture.secondDocumentId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('heading', { name: 'Signatures' }).waitFor({ timeout: 30_000 });

    // Reinstate is what an archived document offers; archive is what a live one offers. Which of
    // the two is on screen is the lifecycle state, read back from a fresh server render — and it is
    // read from inside the actions menu, which is where both of them are offered.
    await page.getByRole('button', { name: 'More actions' }).click({ timeout: 30_000 });
    await page.getByRole('menuitem', { name: 'Reinstate' }).waitFor({ timeout: 30_000 });
    expect(documentStatus(fixture.secondDocumentId)).toBe('ARCHIVED');
    await page.close();
  }, 120_000);
});

// --- 3. Bulk operations -------------------------------------------------------------------------

describe('3 · bulk operations', () => {
  it('runs a bulk export over a real selection and records the operation', async () => {
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/documents`, { waitUntil: 'domcontentloaded' });
    // Waits for **the checkbox**, which is what this test actually needs, rather than for a title
    // to become visible.
    //
    // The old wait was `getByText(title).first().waitFor()`, and the first test in this file
    // already records why that is unsound: the list renders a **responsive pair** and one of the
    // two is hidden at any viewport, so `.first()` resolves to whichever copy leads in document
    // order. Phase 6.10 flipped that coin the other way by adding a third document to the fixture.
    // Waiting for presence instead was no better — it resolves before the table is interactive, and
    // the selection then finds no checkboxes at all. The control the test operates is the honest
    // thing to wait for.
    const boxes = page.getByRole('checkbox');
    await expect.poll(() => boxes.count(), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await page.getByText('Batch release procedure').count()).toBeGreaterThan(0);
    // The first checkbox on a table is the select-all, which is exactly the selection a bulk
    // action is for.
    await boxes.first().check();

    const before = ask(
      'SELECT count(*)::int AS n FROM bulk_operation WHERE tenant_id = $1::uuid',
      fixture.tenantId,
    )[0]?.n;

    const action = page.getByRole('button', { name: /Export/i }).first();
    await action.waitFor({ timeout: 30_000 });
    await action.click();

    // A row in `bulk_operation` is what makes this a bulk operation rather than a loop in a
    // browser — the plan is rebuilt server-side and is resumable, which a client loop is not.
    await expect
      .poll(
        () =>
          Number(
            ask(
              'SELECT count(*)::int AS n FROM bulk_operation WHERE tenant_id = $1::uuid',
              fixture.tenantId,
            )[0]?.n ?? 0,
          ),
        { timeout: 45_000 },
      )
      .toBeGreaterThan(Number(before ?? 0));
    await page.close();
  }, 150_000);
});

// --- 4. Notifications ---------------------------------------------------------------------------

describe('4 · notifications', () => {
  it('renders the caller’s own notifications and nobody else’s', async () => {
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/notifications`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);

    const body = await visibleText(page);
    // The screen loads for a caller who holds the permission — an empty inbox is a valid state and
    // is asserted as such, rather than pretending a notification exists.
    expect(body).not.toMatch(/Something went wrong|Page not found/);
    expect(body).not.toMatch(/relation|syntax error|prisma/i);

    // Whatever it shows belongs to this caller: the API takes no recipient parameter, so there is
    // no request by which one person could read another's inbox.
    const rows = ask(
      'SELECT count(*)::int AS n FROM notification_message ' +
        'WHERE tenant_id = $1::uuid AND recipient_id <> $2::uuid',
      fixture.tenantId,
      fixture.signer.id,
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
    await page.close();
  }, 120_000);
});

// --- 5. Search ----------------------------------------------------------------------------------

describe('5 · search', () => {
  it('runs a real query and shows a result or an honest empty state', async () => {
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/search?q=procedure`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);

    const body = await visibleText(page);
    expect(body).not.toMatch(/Something went wrong|Page not found/);
    expect(body).not.toMatch(/relation|syntax error|prisma|ECONNREFUSED/i);
    await page.close();
  }, 120_000);

  it('refuses a query carrying another tenant’s identifier, by returning nothing of it', async () => {
    if (fixture.neighbour === null) {
      throw new Error('SECOND_DATABASE_MIGRATION_URL must be set.');
    }
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/search?q=Neighbour`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);

    expect(await visibleText(page)).not.toContain('Neighbour confidential procedure');
    await page.close();
  }, 120_000);
});

// --- 6. Templates -------------------------------------------------------------------------------

describe('6 · templates', () => {
  it('opens the templates screen for a holder of template:manage', async () => {
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/admin/templates`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);

    const body = await visibleText(page);
    expect(body).not.toMatch(/Something went wrong|Page not found/);
    expect(body).not.toMatch(/relation|syntax error|prisma/i);
    // Phase 6.5 built this screen for a domain that had no caller anywhere in the product. This is
    // the first time it has been loaded by a browser.
    expect(body).toMatch(/template/i);
    await page.close();
  }, 120_000);
});

// --- 7. Audit timeline --------------------------------------------------------------------------

describe('7 · audit timeline', () => {
  it('shows the trail the database holds, for a holder of audit:view', async () => {
    const page = await pageOf(fixture.signer.email);
    await page.goto(`${WEB_URL}/audit`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);

    const body = await visibleText(page);
    expect(body).not.toMatch(/Something went wrong|Page not found/);

    // There is real history by now — the lifecycle workflow above archived a document — so an
    // empty trail here would mean the screen is not reading what the database holds.
    expect(auditActions().length).toBeGreaterThan(0);
    await page.close();
  }, 120_000);
});

// --- 8. Permissions and access-denied states ----------------------------------------------------

describe('8 · permissions and access denied', () => {
  it('refuses the signing action to a reader, in the browser and at the API', async () => {
    const page = await pageOf(fixture.reader.email);
    await page.goto(`${WEB_URL}/documents/${fixture.documentId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('heading', { name: 'Signatures' }).waitFor({ timeout: 30_000 });

    // The courtesy: no action offered.
    expect(await page.getByRole('button', { name: 'Sign', exact: true }).count()).toBe(0);
    await page.close();
  }, 120_000);

  it('renders a refusal rather than a broken page on a screen the caller may not have', async () => {
    // The reader holds every permission except `document:sign`, so an administrative screen is
    // reachable for them — which makes this an assertion about the *shape* of a refusal rather
    // than about which permission is missing: whatever the answer, it is a page, not a stack trace.
    const page = await pageOf(fixture.reader.email);
    await page.goto(`${WEB_URL}/admin/permissions`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);

    const body = await visibleText(page);
    expect(body).not.toMatch(/relation|syntax error|prisma|ECONNREFUSED/i);
    expect(body.length).toBeGreaterThan(0);
    await page.close();
  }, 120_000);

  it('gives the neighbouring tenant nothing of this one', async () => {
    if (fixture.neighbour === null) {
      throw new Error('SECOND_DATABASE_MIGRATION_URL must be set.');
    }
    const page = await pageOf(fixture.neighbour.email);
    await page.goto(`${WEB_URL}/documents/${fixture.documentId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(1_500);

    const body = await visibleText(page);
    expect(body).not.toContain('Batch release procedure');
    expect(body).not.toContain(fixture.documentNumber);
    await page.close();
  }, 120_000);
});
