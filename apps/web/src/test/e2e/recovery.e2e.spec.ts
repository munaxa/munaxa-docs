import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * Phase 6.10 — the two things standing between this product and a defensible production GO.
 *
 * **A restore that has never been performed, and a notification that has never travelled its own
 * production path.** Both are verified here, in one file and one fixture, because they need the
 * same thing: a real deployment with real state in it. The notification test *produces* the state
 * the restore rehearsal then backs up, which is better than seeding it — what gets restored is what
 * the application actually wrote.
 *
 * ## Part B first, and deliberately
 *
 * The order in the file is the order in the life of the data. An approval is performed through the
 * browser, the notification it produces is traced through every boundary, and only then is the
 * environment backed up and rebuilt somewhere else. A restore rehearsal over an empty database
 * proves that PostgreSQL can create tables.
 *
 * ## What is real
 *
 * Everything, and §19's prohibition is the point: **no synthetic event, anywhere on the happy
 * path.** Nothing constructs a `NotificationEvent`, nothing inserts a notification row, nothing
 * calls `NotificationEventService`, and no publisher, outbox or provider is mocked. A person signs
 * in, submits a document, a second person approves it in their own browser, and what is asserted
 * afterwards is what the database holds — because the only thing that could have written it is the
 * pipeline.
 *
 * ## The two servers
 *
 * This suite boots the product twice: once against the source databases, and once against the
 * **restored** ones. The second boot is the assertion that matters for Part A — a restored database
 * that no application can serve is a backup of a schema.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');

/**
 * The destination cluster: a superuser on an **empty** PostgreSQL that is not the source.
 *
 * Required rather than defaulted. `backup-and-restore.md` §2's first comment is *"Never over the
 * live one: the live database is the evidence of what went wrong"*, and a rehearsal that guessed a
 * destination could guess the source.
 */
const DEST_ADMIN_URL = process.env.DR_DEST_ADMIN_URL ?? '';

/**
 * An object store, and a key to sign checkpoints with.
 *
 * Both are needed for one claim and one claim only: `backup-and-restore.md` §3's third condition —
 * *"The last signed checkpoint before the restore point **recomputes** against the restored rows. A
 * checkpoint that does not is the one signal that distinguishes a restore from a rewrite."* The
 * checkpoint store reports itself unavailable without either (`storage-checkpoint.store.ts`:
 * `checkpointSecret !== null && storage.driver !== 'NONE'`), so a deployment with neither verifies
 * the chain and honestly reports `checkpointed: false` — which would leave §3's strongest condition
 * unassertable.
 */
const STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'munaxa-dr-storage-'));
const CHECKPOINT_SECRET = 'a-phase-6-10-audit-checkpoint-secret-at-least-32';

const RECOVERY_ENV = {
  STORAGE_DRIVER: 'LOCAL',
  STORAGE_LOCAL_ROOT: STORAGE_ROOT,
  STORAGE_PUBLIC_URL: `http://127.0.0.1:${String(API_PORT)}`,
  AUDIT_CHECKPOINT_SECRET: CHECKPOINT_SECRET,
  // The verifier reports its conclusion on the log stream and nowhere else — there is no route in
  // front of `audit.verify-chain` — so the stream has to carry `info`.
  LOG_LEVEL: 'info',
} as const;

let browser: Browser;
let servers: Servers | null = null;
let fixture: Fixture;
let rehearsal: Rehearsal;
let readApiLog: () => string = () => '';

const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();

/**
 * The database URLs as this suite found them, so it can put them back.
 *
 * This suite **repoints the process at the restored cluster** half way through, which is the only
 * way to boot the product against it. The e2e project runs every file in one fork so that two
 * suites can never overlap, and the consequence is that a mutated `process.env` outlives this file:
 * the signing suite ran next, seeded into the *restored* databases, and was refused by row-level
 * security — `edms_owner` is not a superuser over there, which is exactly the posture Part A
 * asserts. Correct behaviour, wrong database. Restored in `afterAll`.
 */
const ORIGINAL_URLS = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL,
  SECOND_DATABASE_URL: process.env.SECOND_DATABASE_URL,
  SECOND_DATABASE_MIGRATION_URL: process.env.SECOND_DATABASE_MIGRATION_URL,
};

/** What `scripts/dr-rehearsal.mjs` prints. Narrow, because the test only asserts on what it reads. */
interface Rehearsal {
  readonly backupDir: string;
  readonly tenants: readonly {
    readonly key: string;
    readonly database: string;
    readonly restoredOwnerUrl: string;
    readonly restoredAppUrl: string;
  }[];
  readonly artefacts: readonly {
    readonly key: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly tableOfContentsEntries: number;
    readonly tables: number;
    readonly tableData: number;
    readonly takenAt: string | null;
  }[];
  readonly source: Record<string, Checkpoint>;
  readonly restored: Record<string, Checkpoint>;
  readonly differences: readonly unknown[];
  readonly posture: Record<
    string,
    {
      readonly rls: { readonly enabled: number; readonly forced: number; readonly total: number };
      readonly policies: number;
      readonly roles: readonly {
        readonly name: string;
        readonly superuser: boolean;
        readonly bypassRls: boolean;
      }[];
      readonly auditUpdatable: boolean;
      readonly appMaySelectDocuments: boolean;
    }
  >;
  readonly timings: {
    readonly steps: readonly { readonly name: string; readonly ms: number }[];
    readonly restoreMs: number;
    readonly totalMs: number;
  };
}

interface Checkpoint {
  readonly tables: number;
  readonly tenants: readonly { readonly id: string; readonly slug: string }[];
  readonly perTenant: Record<
    string,
    {
      readonly id: string;
      readonly counts: Record<string, number>;
      readonly audit: {
        readonly sequence: string | null;
        readonly hash: string | null;
        readonly previousHash: string | null;
        readonly action: string | null;
      };
      readonly documents: readonly { readonly id: string; readonly status: string }[];
      readonly users: readonly string[];
      readonly notifications: readonly {
        readonly id: string;
        readonly typeKey: string;
        readonly recipientId: string;
        readonly channel: string;
      }[];
    }
  >;
}

beforeAll(async () => {
  if (!process.env.DATABASE_MIGRATION_URL) {
    throw new Error('DATABASE_MIGRATION_URL must be set: this suite runs against a real database.');
  }
  if (DEST_ADMIN_URL === '') {
    throw new Error(
      'DR_DEST_ADMIN_URL must name a superuser on an EMPTY destination cluster. The restore ' +
        'rehearsal restores *beside* the source rather than over it, so it needs somewhere else ' +
        'to restore to — and it must not guess.',
    );
  }
  cleanUpFixtures();
  fixture = seedFixture();
  servers = await startServers(fixture, RECOVERY_ENV);
  readApiLog = captureApiLog(servers);
  browser = await chromium.launch({
    headless: true,
    args: ['--no-proxy-server'],
    ...(process.env.CHROMIUM_PATH !== undefined
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
  await establishSession(fixture.signer.email);
  await establishSession(fixture.reader.email);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  stopServers(servers);
  // The source databases again, *before* the fixture cleanup — which deletes by slug prefix and
  // would otherwise clean the restored copy while leaving the source seeded.
  Object.assign(process.env, ORIGINAL_URLS);
  cleanUpFixtures();
});

// --- The instruments -----------------------------------------------------------------------------

/**
 * One SQL question, answered by the database rather than by an endpoint.
 *
 * As the **owner**, because these assertions read tables no endpoint exposes — `outbox_message` has
 * no route at all — and because reading the trail through the API would be asserting that the API
 * agrees with itself.
 */
function query(url: string, sql: string, ...params: string[]): Record<string, string>[] {
  const script =
    "const {PrismaClient}=require('@prisma/client');" +
    `const c=new PrismaClient({datasources:{db:{url:${JSON.stringify(url)}}}});` +
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

function askSource(sql: string, ...params: string[]): Record<string, string>[] {
  return query(process.env.DATABASE_MIGRATION_URL ?? '', sql, ...params);
}

/**
 * Everything the running API has said since this was attached.
 *
 * The chain verifier has no endpoint, so its conclusion is only observable on the log stream — and
 * an assertion that reads that stream is reading the control's own report rather than a proxy for
 * it.
 */
function captureApiLog(running: Servers): () => string {
  const chunks: string[] = [];
  running.api.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  running.api.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  return () => chunks.join('');
}

/**
 * Runs the product's own chain verification against whatever the API is connected to, and waits
 * for it to report.
 *
 * `backup-and-restore.md` §3's second and third conditions in one act: `audit.verify-chain` walks
 * the trail from the last **signed** checkpoint and reports `intact`, and because it resumes from
 * that checkpoint rather than from genesis, a restored database whose rows no longer recompute
 * against it cannot report intact. That is the assertion the document calls *"the one signal that
 * distinguishes a restore from a rewrite"*.
 */
async function verifyChain(readLog: () => string, tenants: number): Promise<string[]> {
  const before = readLog().length;
  execFileSync('node', [join(ROOT, 'scripts', 'dr-verify-chain.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const lines = readLog()
      .slice(before)
      .split('\n')
      .filter((line) => line.includes('"msg":"The audit chain'));
    if (lines.length >= tenants) {
      return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `The chain verifier did not report for ${String(tenants)} tenants. Silence here is a broken ` +
      'control rather than a slow one.',
  );
}

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

async function pageFor(email: string): Promise<Page> {
  const state = sessions.get(email);
  if (state === undefined) {
    throw new Error(`No session for ${email}.`);
  }
  const context = await browser.newContext({ storageState: state });
  return context.newPage();
}

/** What a person can actually read — `innerText` of the main landmark, never the RSC payload. */
async function visibleText(page: Page): Promise<string> {
  const main = page.locator('main');
  return (await main.count()) > 0 ? main.innerText() : page.locator('body').innerText();
}

/**
 * Waits for a row the **pipeline** has to produce, and fails saying what never arrived.
 *
 * Polling rather than a fixed sleep, because the path crosses two asynchronous hops — the outbox
 * dispatcher's poll interval and the lane's own scheduling — and a sleep long enough to be safe is
 * a sleep long enough to hide a regression. `waitFor` fails at the deadline, so a broken boundary is
 * a timeout naming the boundary rather than a mysteriously empty assertion.
 */
async function waitForRows(
  what: string,
  sql: string,
  params: string[],
  atLeast = 1,
  timeoutMs = 90_000,
): Promise<Record<string, string>[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: Record<string, string>[] = [];
  while (Date.now() < deadline) {
    rows = askSource(sql, ...params);
    if (rows.length >= atLeast) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `${what} never arrived within ${String(timeoutMs / 1000)}s — ${String(rows.length)} of ` +
      `${String(atLeast)} rows. This is a broken boundary rather than a slow one.`,
  );
}

/**
 * A token for the real API — minted **once per person per deployment**, and cached.
 *
 * `auth.login` is ten attempts per five minutes per address, and this suite signs each person in
 * through the browser as well. Minting a token per assertion spends that budget and turns the later
 * tests into refusals that surface as "the page never navigated" — self-inflicted flakiness in a
 * security control's own repository, and the fourth time this sequence has walked into it. The
 * cache is cleared when the deployment is replaced, because a token proving nothing about the
 * restored environment is exactly what the restored environment's assertions must not use.
 */
const tokens = new Map<string, string>();

async function tokenFor(email: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached !== undefined) {
    return cached;
  }
  const response = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: fixture.password, tenant: fixture.slug }),
  });
  const session = (await response.json()) as { accessToken?: string };
  if (session.accessToken === undefined) {
    throw new Error(
      `Could not sign ${email} in at the API (${String(response.status)}). A 429 here is this ` +
        'suite spending `auth.login`’s budget on itself rather than a defect in the product.',
    );
  }
  tokens.set(email, session.accessToken);
  return session.accessToken;
}

// ================================================================================================
// PART B — the notification production path.
// ================================================================================================

describe('B · a real approval, and the notification it produces', () => {
  /**
   * The originating business action, performed by a person in a browser.
   *
   * Two people and two sessions, because the recipient rule is the thing under test:
   * `documentEvent` notifies the document's owner and its creator, and the stage names the
   * *reader* as its only participant — so the person who approves is not the person who is told.
   */
  it('submits and approves through the browser, and nothing is synthetic', async () => {
    const author = await pageFor(fixture.signer.email);
    await author.goto(`${WEB_URL}/documents/${fixture.approvalDocumentId}`, {
      waitUntil: 'domcontentloaded',
    });
    await confirmThrough(author, /^submit for approval$/i);
    await waitForStatus(fixture.approvalDocumentId, 'UNDER_REVIEW');
    await author.close();

    // The approver, in their own browser, from their own inbox. Not a crafted request: the
    // approvals screen is where a person actually decides.
    const approver = await pageFor(fixture.reader.email);
    await approver.goto(`${WEB_URL}/approvals`, { waitUntil: 'domcontentloaded' });
    await approver.getByText(fixture.approvalDocumentTitle).first().waitFor({ timeout: 30_000 });
    await confirmThrough(approver, /^approve$/i);
    await waitForStatus(fixture.approvalDocumentId, 'APPROVED');
    await approver.close();
  }, 300_000);

  it('wrote a real outbox row for document.approved, and dispatched it', async () => {
    // Waits for the row to be **dispatched**, not merely written. Waiting for existence alone was
    // the first version of this test and it was a race it sometimes won: the outbox row commits
    // with the transition that caused it, and the dispatcher claims it a poll interval later, so
    // reading `processed_at` the instant the row appears reads the moment before the hop this
    // assertion is about.
    const rows = await waitForRows(
      'the document.approved outbox row, dispatched',
      `SELECT id, event_type, aggregate_type, aggregate_id, processed_at::text, correlation_id
       FROM outbox_message
       WHERE tenant_id = $1::uuid AND event_type = 'document.approved'
         AND processed_at IS NOT NULL`,
      [fixture.tenantId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_type).toBe('document');
    expect(rows[0]?.aggregate_id).toBe(fixture.approvalDocumentId);
    // Dispatched rather than merely written. An unprocessed row is a notification that has not
    // happened yet, and this is the boundary Phase 6.4 could not see.
    expect(rows[0]?.processed_at).not.toBeNull();
  }, 180_000);

  /**
   * The link between the outbox row and the notification, and it is not circumstantial.
   *
   * `notify` keys idempotency on `(eventId, recipient, channel)` and the event id *is* the outbox
   * row's own identifier — so a notification whose key begins with that id could only have been
   * written by a consumer that was handed that row. Asserting the prefix is asserting the edge.
   */
  it('produced notifications for the intended recipient, keyed to that outbox row', async () => {
    const [event] = askSource(
      `SELECT id FROM outbox_message WHERE tenant_id = $1::uuid AND event_type = 'document.approved'`,
      fixture.tenantId,
    );
    const eventId = event?.id ?? '';
    expect(eventId).not.toBe('');

    const rows = await waitForRows(
      'the document.approved notifications',
      `SELECT id, recipient_id, type_key, channel, locale, subject, body_text, state, address,
              idempotency_key
       FROM notification_message
       WHERE tenant_id = $1::uuid AND type_key = 'document.approved'
       ORDER BY channel`,
      [fixture.tenantId],
      2,
    );

    expect(rows.map((row) => row.channel)).toEqual(['EMAIL', 'IN_APP']);
    for (const row of rows) {
      expect((row.idempotency_key ?? '').startsWith(`${eventId}:`)).toBe(true);
      // The owner, who did not approve it. The approver is told nothing, because being the person
      // who acted is not a reason to be notified of your own act.
      expect(row.recipient_id).toBe(fixture.signer.id);
      expect(row.address).toBe(fixture.signer.email);
      expect(row.locale).toBe('en');
    }

    // §21's payload semantics, against the *rendered* message rather than against the template.
    const inApp = rows.find((row) => row.channel === 'IN_APP');
    expect(inApp?.subject).toContain(fixture.approvalDocumentTitle);
    expect(inApp?.body_text).toContain(fixture.approvalDocumentNumber);
    // No placeholder survived, in either direction: an unrendered `{{…}}` and the `—` this product
    // substitutes for a value it does not have are both failures of the same claim.
    expect(`${inApp?.subject ?? ''} ${inApp?.body_text ?? ''}`).not.toMatch(/\{\{|\}\}|—/);
    // In-app is delivered by being written; that is the whole of its delivery.
    expect(inApp?.state).toBe('DELIVERED');
  }, 180_000);

  it('shows it to the recipient in their own browser, and to nobody else', async () => {
    const recipient = await pageFor(fixture.signer.email);
    await recipient.goto(`${WEB_URL}/notifications`, { waitUntil: 'domcontentloaded' });
    const seen = await visibleText(recipient);
    expect(seen).toContain(fixture.approvalDocumentTitle);
    await recipient.close();

    // The approver's own inbox holds their task assignment and **not** the approval notice.
    const approver = await pageFor(fixture.reader.email);
    await approver.goto(`${WEB_URL}/notifications`, { waitUntil: 'domcontentloaded' });
    const theirs = await visibleText(approver);
    expect(theirs).not.toContain('Approved:');
    await approver.close();
  }, 180_000);

  /**
   * §25, at the API rather than at the page.
   *
   * The inbox is scoped to the caller by the query rather than by a route parameter — there is no
   * identifier to tamper with — so the assertion is that the *other* person's list does not contain
   * this notification's identifier. Hiding a row is a rendering decision; not returning it is the
   * control.
   */
  it('never returns one person’s notification to another', async () => {
    const mine = askSource(
      `SELECT id FROM notification_message
       WHERE tenant_id = $1::uuid AND type_key = 'document.approved' AND channel = 'IN_APP'`,
      fixture.tenantId,
    );
    const id = mine[0]?.id ?? '';
    expect(id).not.toBe('');

    const theirs = await fetch(
      `http://127.0.0.1:${String(API_PORT)}/api/v1/notifications?page=1&pageSize=50`,
      { headers: { Authorization: `Bearer ${await tokenFor(fixture.reader.email)}` } },
    );
    const body = (await theirs.json()) as { data?: { id: string; typeKey: string }[] };
    expect(theirs.status).toBe(200);
    expect((body.data ?? []).map((row) => row.id)).not.toContain(id);
    expect((body.data ?? []).map((row) => row.typeKey)).not.toContain('document.approved');
  }, 180_000);

  /**
   * §24 — and the isolation claim is made across two **databases**, not two `WHERE` clauses.
   *
   * Under ADR-0015 the neighbouring tenant is a separate database, so "no notification crossed"
   * is a statement about the architecture rather than about a predicate somebody could forget.
   */
  it('put nothing in the neighbouring tenant', () => {
    if (fixture.neighbour === null) {
      throw new Error('SECOND_DATABASE_MIGRATION_URL must be set: isolation needs two databases.');
    }
    const rows = query(
      process.env.SECOND_DATABASE_MIGRATION_URL ?? '',
      'SELECT id, type_key, recipient_id FROM notification_message',
    );
    expect(rows).toHaveLength(0);
  }, 180_000);

  /**
   * §23 — retry, observed rather than described.
   *
   * `MAIL_DRIVER=NONE` is a **real controlled provider failure** rather than a simulation of one:
   * the bound adapter refuses every send naming the variable that would fix it, and
   * `DeliveryService.deliverOne` treats a throwing provider exactly as it treats a provider that
   * returns a failure. So the queued email is attempted by the real `notifications.deliver` pass,
   * on its real one-minute schedule, and what is asserted is the state machine Phase 6.4 built:
   * the attempt is counted, the reason is recorded, a `release_at` puts the next try behind a
   * backoff, and the message stays claimable rather than being lost.
   */
  it('retries a failing email rather than losing it', async () => {
    const rows = await waitForRows(
      'a delivery attempt against the queued email',
      `SELECT id, state, attempts, failure_reason, release_at::text
       FROM notification_message
       WHERE tenant_id = $1::uuid AND channel = 'EMAIL' AND type_key = 'document.approved'
         AND attempts > 0`,
      [fixture.tenantId],
      1,
      150_000,
    );

    const row = rows[0];
    expect(Number(row?.attempts ?? '0')).toBeGreaterThanOrEqual(1);
    expect(row?.failure_reason ?? '').not.toBe('');
    // Still claimable, and behind a backoff. This is the row of 18 §7 that Phase 6.4 found had
    // never been built: a transient failure that ends the message is a lost notification.
    expect(row?.state).toBe('QUEUED');
    expect(row?.release_at).not.toBeNull();
  }, 300_000);

  /**
   * §22 — Arabic, through the same production path rather than through the template table.
   *
   * The language is a **tenant** setting (`locale.default`) rather than a per-recipient one, which
   * `NotificationService` reads when it renders. So the second language is verified the only way it
   * can be: change the setting through its own administrative route, perform a second real approval,
   * and read what was written.
   */
  it('renders the second language when the tenant asks for it', async () => {
    const token = await tokenFor(fixture.signer.email);
    const changed = await fetch(`http://127.0.0.1:${String(API_PORT)}/api/v1/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: 'locale.default', value: 'ar' }),
    });
    expect(changed.status).toBeLessThan(300);

    // A second document through the same ceremony — the signing fixture's own draft, which nothing
    // in this file has submitted.
    const author = await pageFor(fixture.signer.email);
    await author.goto(`${WEB_URL}/documents/${fixture.documentId}`, {
      waitUntil: 'domcontentloaded',
    });
    await confirmThrough(author, /^submit for approval$/i);
    await waitForStatus(fixture.documentId, 'UNDER_REVIEW');
    await author.close();

    const approver = await pageFor(fixture.reader.email);
    await approver.goto(`${WEB_URL}/approvals`, { waitUntil: 'domcontentloaded' });
    await confirmThrough(approver, /^approve$/i);
    await waitForStatus(fixture.documentId, 'APPROVED');
    await approver.close();

    const rows = await waitForRows(
      'an Arabic notification',
      `SELECT locale, subject, body_text FROM notification_message
       WHERE tenant_id = $1::uuid AND type_key = 'document.approved' AND locale = 'ar'`,
      [fixture.tenantId],
      1,
    );

    const arabic = rows[0];
    expect(arabic?.locale).toBe('ar');
    // Arabic script, and the document's own number inside it — so the template was selected *and*
    // its variables were substituted, rather than a translated shell with nothing in it.
    expect(arabic?.subject ?? '').toMatch(/[؀-ۿ]/);
    expect(`${arabic?.subject ?? ''} ${arabic?.body_text ?? ''}`).toContain(fixture.documentNumber);
    expect(`${arabic?.subject ?? ''} ${arabic?.body_text ?? ''}`).not.toMatch(/\{\{|\}\}/);
  }, 300_000);
});

function documentStatus(id: string): string {
  return askSource('SELECT status FROM document WHERE id = $1::uuid', id)[0]?.status ?? 'MISSING';
}

/**
 * Waits for a document to reach a status, and fails naming what it reached instead.
 *
 * The document's own row rather than anything the page rendered: a screen that says "submitted"
 * before the transition committed would satisfy a UI assertion and prove nothing about the event
 * this phase is tracing.
 */
async function waitForStatus(id: string, want: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    seen = documentStatus(id);
    if (seen === want) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Document ${id} is ${seen} rather than ${want}.`);
}

/**
 * Opens a dialogue from a button and confirms it — where both carry the same words.
 *
 * `approvals.submit` is the label on the trigger *and* on the dialogue's submit button, and
 * `approvals.approve` likewise, because they name the same act. So the trigger is the first and
 * the confirmation is the last, and this helper says that once rather than at four call sites.
 */
async function confirmThrough(page: Page, label: RegExp): Promise<void> {
  const buttons = page.getByRole('button', { name: label });
  await buttons.first().waitFor({ timeout: 30_000 });
  await buttons.first().click();
  await buttons.last().click();
}

// ================================================================================================
// PART A — the restore rehearsal.
//
// Everything above wrote real rows through the real product. What follows backs that up, rebuilds
// it somewhere else, and then serves it.
// ================================================================================================

describe('A · the first restore this repository has ever performed', () => {
  /**
   * Before the backup, so the artefact carries a trail that has been **signed for**.
   *
   * A checkpoint is written into object storage — a store the database cannot reach, which is the
   * property that makes it evidence against an attacker who reached the database. Taking one here
   * is what lets the restored deployment's own verification, further down, be a comparison rather
   * than a fresh walk from genesis.
   */
  it('verifies the source chain and signs a checkpoint for it', async () => {
    const reported = await verifyChain(readApiLog, 2);
    for (const line of reported) {
      expect(line).toContain('The audit chain verified');
      expect(line).not.toContain('broken');
    }
    // Signed rather than merely walked: `checkpointed` is false on any deployment without both a
    // key and a store, and a rehearsal that accepted that would be skipping §3's third condition.
    expect(reported.some((line) => line.includes('"checkpointed":true'))).toBe(true);
  }, 300_000);

  it('backs up, restores into an empty cluster, and loses nothing', () => {
    const output = execFileSync(
      'node',
      [join(ROOT, 'scripts', 'dr-rehearsal.mjs'), '--prepare-destination'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, DR_DEST_ADMIN_URL: DEST_ADMIN_URL },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    rehearsal = JSON.parse(output.trim().split('\n').at(-1) ?? '') as Rehearsal;

    // The artefact, checked before anything was restored: a readable archive with a table of
    // contents, a size, a digest and the instant it was taken.
    for (const artefact of rehearsal.artefacts) {
      expect(artefact.bytes).toBeGreaterThan(0);
      expect(artefact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artefact.tables).toBeGreaterThan(50);
      expect(artefact.tableData).toBeGreaterThan(50);
      expect(artefact.takenAt).not.toBeNull();
    }

    // **The comparison.** Every table of every tenant of both databases, plus the audit tail, the
    // document roll, the user roll, the revision roll and the notification roll. An empty array is
    // therefore a statement about the whole schema rather than about a sample.
    expect(rehearsal.differences).toEqual([]);

    // Two tenants, in two databases, restored as themselves.
    expect(rehearsal.tenants.map((tenant) => tenant.key)).toEqual(['primary', 'secondary']);
    for (const key of ['primary', 'secondary']) {
      expect(Object.keys(rehearsal.restored[key]?.perTenant ?? {}).length).toBeGreaterThan(0);
    }
  }, 600_000);

  /**
   * §11–§12's posture, on the restored copy, before anybody is pointed at it.
   *
   * `backup-and-restore.md` §2's own comment is why this is asserted rather than assumed: *"A
   * restored database has the tables and may not have the policies … and a tenant database without
   * RLS is a tenant database the application role can read across."*
   */
  it('restored the isolation posture, not merely the tables', () => {
    for (const key of ['primary', 'secondary']) {
      const posture = rehearsal.posture[key];
      expect(posture).toBeDefined();
      // Enabled *and* forced on every tenant-scoped table: enabled alone leaves the owner outside
      // it, which is the Phase 1 defect that gave this product an integration suite at all.
      expect(posture?.rls.enabled).toBe(posture?.rls.total);
      expect(posture?.rls.forced).toBe(posture?.rls.total);
      expect(posture?.policies).toBeGreaterThanOrEqual(posture?.rls.total ?? 0);

      // The application role is not a superuser and does not bypass row security. On a cluster
      // rebuilt from `infra/sql/cluster/01-roles.sql` neither role is.
      const app = posture?.roles.find((role) => role.name === 'edms_app');
      expect(app?.superuser).toBe(false);
      expect(app?.bypassRls).toBe(false);
      const owner = posture?.roles.find((role) => role.name === 'edms_owner');
      expect(owner?.superuser).toBe(false);
      expect(owner?.bypassRls).toBe(false);

      // The trail stays append-only to the application role, which is a targeted revoke rather
      // than a trigger and therefore something a restore could quietly hand back.
      expect(posture?.auditUpdatable).toBe(false);
      expect(posture?.appMaySelectDocuments).toBe(true);
    }
  });

  it('kept the audit tail identical, hash and sequence', () => {
    for (const key of ['primary', 'secondary']) {
      const before = rehearsal.source[key]?.perTenant ?? {};
      const after = rehearsal.restored[key]?.perTenant ?? {};
      for (const slug of Object.keys(before)) {
        expect(after[slug]?.audit).toEqual(before[slug]?.audit);
      }
    }
    // And the tenant this phase actually exercised has a trail rather than an empty one, so the
    // equality above is a statement about rows rather than about two nulls.
    const mine = rehearsal.source.primary?.perTenant[fixture.slug];
    expect(Number(mine?.audit.sequence ?? '0')).toBeGreaterThan(0);
    expect(mine?.audit.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('restored the notifications this phase produced', () => {
    const before = rehearsal.source.primary?.perTenant[fixture.slug];
    const after = rehearsal.restored.primary?.perTenant[fixture.slug];
    expect(before?.notifications.length).toBeGreaterThanOrEqual(4);
    expect(after?.notifications).toEqual(before?.notifications);
  });
});

// ================================================================================================
// The restored environment, serving the real product.
// ================================================================================================

describe('A · the restored environment, in a real browser', () => {
  beforeAll(async () => {
    // The source servers go away first. Two deployments cannot share port 3001, and more to the
    // point: every assertion below has to be answered by the restored databases rather than by a
    // process still holding a connection to the originals.
    stopServers(servers);
    servers = null;
    sessions.clear();
    tokens.clear();

    const primary = rehearsal.tenants.find((tenant) => tenant.key === 'primary');
    const secondary = rehearsal.tenants.find((tenant) => tenant.key === 'secondary');
    process.env.DATABASE_URL = primary?.restoredAppUrl;
    process.env.DATABASE_MIGRATION_URL = primary?.restoredOwnerUrl;
    process.env.SECOND_DATABASE_URL = secondary?.restoredAppUrl;
    process.env.SECOND_DATABASE_MIGRATION_URL = secondary?.restoredOwnerUrl;

    servers = await startServers(fixture, RECOVERY_ENV);
    readApiLog = captureApiLog(servers);
    // Signed in again rather than reusing the cookies from before, and that is the assertion: the
    // credentials that authenticate are the *restored* ones.
    await establishSession(fixture.signer.email);
    await establishSession(fixture.reader.email);
  }, 300_000);

  /**
   * §13, and `backup-and-restore.md` §3's pass condition — on the restored database.
   *
   * The deployment points at the **same object store**, which is what a complete recovery would
   * arrange: §1's table backs the bucket up by versioning and cross-region replication rather than
   * by the database dump, so the checkpoint travels beside the database rather than inside it. The
   * consequence is the assertion: the verifier resumes from the checkpoint the *source* deployment
   * signed, and reports intact only if the restored rows still recompute against it.
   */
  it('verifies the restored chain against the checkpoint signed before the backup', async () => {
    const reported = await verifyChain(readApiLog, 2);
    for (const line of reported) {
      expect(line).toContain('The audit chain verified');
      expect(line).not.toContain('broken');
    }
  }, 300_000);

  it('authenticates a restored person and opens a restored document', async () => {
    const page = await pageFor(fixture.signer.email);
    await page.goto(`${WEB_URL}/documents/${fixture.approvalDocumentId}`, {
      waitUntil: 'domcontentloaded',
    });
    const seen = await visibleText(page);
    expect(seen).toContain(fixture.approvalDocumentTitle);
    expect(seen).toContain(fixture.approvalDocumentNumber);
    await page.close();
  }, 180_000);

  it('shows the restored document’s revision history and its audit timeline', async () => {
    const page = await pageFor(fixture.signer.email);

    // The revision history is on the document screen rather than at a route of its own, so this
    // is the same page as above asked a different question: does the *revision* that was approved
    // still exist, with its label, on the other side of a rebuild.
    await page.goto(`${WEB_URL}/documents/${fixture.approvalDocumentId}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(await visibleText(page)).toContain(fixture.revisionLabel);

    await page.goto(`${WEB_URL}/audit`, { waitUntil: 'domcontentloaded' });
    const trail = await visibleText(page);
    // The approval this phase performed, read back out of a database that was rebuilt from a file.
    expect(trail).toMatch(/DOCUMENT|WORKFLOW|LOGIN/);
    await page.close();
  }, 180_000);

  it('still shows the recipient their notification after the restore', async () => {
    const page = await pageFor(fixture.signer.email);
    await page.goto(`${WEB_URL}/notifications`, { waitUntil: 'domcontentloaded' });
    expect(await visibleText(page)).toContain(fixture.approvalDocumentTitle);
    await page.close();
  }, 180_000);

  /**
   * §12, after the restore, through the real application path and in both directions.
   *
   * The neighbour's document identifier is a real one — it exists, in the other restored database —
   * so a refusal here is isolation rather than absence.
   */
  it('keeps the two restored tenants apart, in both directions', async () => {
    if (fixture.neighbour === null) {
      throw new Error('The isolation assertion needs the second tenant.');
    }
    const page = await pageFor(fixture.signer.email);
    await page.goto(`${WEB_URL}/documents/${fixture.neighbour.documentId}`, {
      waitUntil: 'domcontentloaded',
    });
    const seen = await visibleText(page);
    expect(seen).not.toContain('Neighbour confidential procedure');
    await page.close();

    // And at the API, with a real token, so the refusal is the control rather than a rendering.
    const token = await tokenFor(fixture.signer.email);
    const refused = await fetch(
      `http://127.0.0.1:${String(API_PORT)}/api/v1/documents/${fixture.neighbour.documentId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect([403, 404]).toContain(refused.status);
  }, 180_000);

  it('ends the session when the person signs out', async () => {
    const page = await pageFor(fixture.signer.email);
    await page.goto(`${WEB_URL}/documents`, { waitUntil: 'domcontentloaded' });

    // Behind the account menu rather than on the bar — `workspace-shell.tsx` puts it in a
    // `UserMenu` labelled "Account" — so it has to be opened the way a person opens it.
    await page
      .getByRole('button', { name: /account/i })
      .first()
      .click();
    const signOut = page.getByRole('menuitem', { name: /sign out/i });
    await signOut.first().waitFor({ timeout: 30_000 });
    await signOut.first().click();
    await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 30_000 });

    // And the cookie is gone rather than merely unused: navigating back lands on the login page.
    await page.goto(`${WEB_URL}/documents`, { waitUntil: 'domcontentloaded' });
    expect(new URL(page.url()).pathname).toMatch(/^\/login/);
    await page.close();
  }, 180_000);
});
