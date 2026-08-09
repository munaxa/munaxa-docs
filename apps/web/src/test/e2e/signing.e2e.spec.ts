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
}, 240_000);

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
async function establishSession(email: string): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${WEB_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(fixture.password);
  await page.getByLabel('Organisation').fill(fixture.slug);
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
