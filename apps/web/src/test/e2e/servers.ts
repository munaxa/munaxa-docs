import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The real application, booted — Phase 6.6, and infrastructure this repository did not have.
 *
 * ## Why this exists, when there is already a "browser" suite
 *
 * `src/test/browser.ts` renders **static markup** into Chromium with the built stylesheet, and its
 * own comment says why: *"Screenshotting the running application would need the API, a database, a
 * session and a tenant — four things that make a UI test fail for reasons that are not about the
 * UI."* That trade is right for contrast and for screenshots.
 *
 * It is wrong for a signing ceremony. The one claim this phase has to make is that a person can
 * sign a document through the real product, and that what they were shown is what the database
 * stored. Every part of that lives in the four things the visual harness deliberately avoids: the
 * session cookie, the tenant, the API and the row. So this harness pays the cost the other one
 * declined, and the two coexist rather than one replacing the other.
 *
 * ## What is real
 *
 * Everything. The API is `apps/api/dist/main.js` — the artefact the container image ships — against
 * a real PostgreSQL and a real Redis. The web application is `next start` over the production
 * build. The browser is Chromium driving the shipped HTML and JavaScript. Nothing is mocked, nothing
 * is stubbed, and the signature endpoint least of all.
 *
 * ## Ports
 *
 * The API listens on **3001** because that is `apiBaseUrl()`'s default and `NEXT_PUBLIC_API_URL` is
 * inlined into the build; picking a random port would mean the built application still talking to
 * 3001 while the test talked to something else. The web server takes a port from the environment so
 * two runs do not collide.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', '..');
const ROOT = join(WEB, '..', '..');
const API = join(ROOT, 'apps', 'api');

export const API_PORT = 3001;
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3210);
export const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;

export interface Person {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
}

export interface Fixture {
  readonly tenantId: string;
  readonly slug: string;
  readonly password: string;
  readonly signer: { readonly id: string; readonly email: string; readonly name: string };
  readonly reader: { readonly id: string; readonly email: string };
  /**
   * The product's own auditor, holding `DEFAULT_ROLE_PERMISSIONS.AUDITOR` and nothing else.
   *
   * The signer and the reader both hold effectively the whole catalogue, which makes them useless
   * for an authorization question: a suite whose only callers are superusers cannot notice a screen
   * that depends on a permission it should not. It did not notice — `/search` was the route error
   * boundary for two of the three seeded roles that can open it, through twenty-five green tests.
   */
  readonly auditor: { readonly id: string; readonly email: string };
  /**
   * The seeded document controller, plus the two operational read keys the shipped migration
   * grants it — and nothing else. Between this and the auditor, the two roles the `/search`
   * defect actually locked out are both represented by their real permission sets.
   */
  readonly controller: { readonly id: string; readonly email: string };
  readonly documentId: string;
  readonly revisionId: string;
  readonly revisionLabel: string;
  readonly documentNumber: string;
  readonly contentSha256: string;
  readonly libraryId: string;
  readonly folderId: string;
  /** A second document, so a bulk selection has something to select. */
  readonly secondDocumentId: string;
  /**
   * The document Phase 6.10 submits and approves — its own, so an approval cannot disturb the
   * revision the signing ceremony signs. The type it carries points at a **published** workflow
   * version whose single stage names the reader, so the approver and the person notified are two
   * different people.
   */
  readonly approvalDocumentId: string;
  readonly approvalRevisionId: string;
  readonly approvalDocumentNumber: string;
  readonly approvalDocumentTitle: string;
  /**
   * The neighbouring tenant — Phase 6.9.
   *
   * A second *database*, not a second row: ADR-0015 is database-per-tenant, so an isolation claim
   * made inside one database would be a claim about a `WHERE` clause rather than about the
   * architecture. Present only when `SECOND_DATABASE_MIGRATION_URL` is configured.
   */
  readonly neighbour: {
    readonly tenantId: string;
    readonly slug: string;
    readonly email: string;
    readonly documentId: string;
  } | null;
}

/**
 * The witness key this run signs under.
 *
 * Set here rather than left to the environment, because a deployment without one *refuses to
 * sign* — which is correct behaviour and would make this suite fail for a reason that is not about
 * the UI. Supplying it in the fixture keeps the refusal a real product behaviour rather than an
 * accident of how CI is configured.
 */
const WITNESS_SECRET = 'a-phase-6-6-e2e-witness-secret-of-at-least-32';

export function seedFixture(): Fixture {
  const output = execFileSync('node', [join(ROOT, 'scripts', 'e2e-signature-fixture.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const line = output.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Fixture;
}

export function cleanUpFixtures(): void {
  execFileSync('node', [join(ROOT, 'scripts', 'e2e-signature-fixture.mjs'), '--cleanup'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
}

export interface Servers {
  readonly api: ChildProcess;
  readonly web: ChildProcess;
}

/**
 * Extra environment for the API process — Phase 6.10, and additive on purpose.
 *
 * The recovery rehearsal needs two things the signing suite must not have: an object store, so the
 * audit checkpoint store is `available` at all, and a checkpoint key to sign with. Both change
 * product behaviour — `STORAGE_DRIVER=LOCAL` puts the preview pipeline on a different path, and
 * Phase 6.9's bounded-issuance assertion is measured against `NONE` — so they are passed by the
 * suite that wants them rather than turned on for every suite.
 */
export type ExtraEnv = Readonly<Record<string, string>>;

export async function startServers(fixture: Fixture, extraEnv: ExtraEnv = {}): Promise<Servers> {
  const main = join(API, 'dist', 'main.js');
  if (!existsSync(main)) {
    throw new Error(
      `No API build at ${main}. This suite runs the artefact the image ships, so it depends on ` +
        '`pnpm build` rather than re-compiling one of its own.',
    );
  }
  if (!existsSync(join(WEB, '.next'))) {
    throw new Error(
      'No web build. This suite runs `next start` over the production build, for the same reason ' +
        'the visual suite reads the built stylesheet: it checks what ships.',
    );
  }

  // Refuse to run against somebody else's server.
  //
  // A leftover process on 3001 answers health checks perfectly well and serves a *different*
  // tenant, so every assertion below fails as an authorization problem and the real cause — a
  // process that outlived an earlier run — is nowhere in the output. Two hours were spent on
  // exactly that; checking first turns it into one sentence.
  await waitUntilFree(`http://127.0.0.1:${String(API_PORT)}`, 'API');
  await waitUntilFree(WEB_URL, 'web');

  // `NODE_ENV` is deliberately **not** forced to `production` here. The API's configuration
  // hardens in production — it refuses `STORAGE_DRIVER=NONE`, demands a TOTP sealing key and an
  // audit checkpoint secret — and those refusals are correct behaviour that this suite has no
  // business disabling by supplying secrets it invented. It runs the shipped *artefact* under the
  // test profile, which is the same thing the integration suites do.
  const apiEnv = { ...process.env };
  delete apiEnv.TENANT_CATALOGUE;
  delete apiEnv.TENANT_CATALOGUE_PATH;

  // One tenant or two, and the shape is chosen by what the fixture actually seeded rather than by a
  // flag: a catalogue naming a neighbour whose database was never migrated would refuse to boot.
  // The two forms are mutually exclusive by configuration validation, so exactly one is set.
  const tenancy =
    fixture.neighbour === null
      ? { TENANT_ID: fixture.tenantId, TENANT_SLUG: fixture.slug }
      : {
          TENANT_CATALOGUE: JSON.stringify({
            tenants: [
              {
                id: fixture.tenantId,
                slug: fixture.slug,
                database: {
                  url: process.env.DATABASE_URL ?? '',
                  migrationUrl: process.env.DATABASE_MIGRATION_URL ?? '',
                },
                storage: { driver: 'LOCAL', container: 'munaxa-docs', prefix: fixture.slug },
                search: { index: `docs-${fixture.slug}` },
              },
              {
                id: fixture.neighbour.tenantId,
                slug: fixture.neighbour.slug,
                database: {
                  url: process.env.SECOND_DATABASE_URL ?? '',
                  migrationUrl: process.env.SECOND_DATABASE_MIGRATION_URL ?? '',
                },
                storage: {
                  driver: 'LOCAL',
                  container: 'munaxa-docs',
                  prefix: fixture.neighbour.slug,
                },
                search: { index: `docs-${fixture.neighbour.slug}` },
              },
            ],
          }),
        };

  const api = spawn('node', [main], {
    cwd: API,
    env: {
      ...apiEnv,
      PORT: String(API_PORT),
      LOG_LEVEL: 'fatal',
      ...tenancy,
      SIGNATURE_WITNESS_SECRET: WITNESS_SECRET,
      CORS_ORIGINS: WEB_URL,
      ...extraEnv,
    },
    // Its own process group, so `stopServers` can take the whole tree down. `next start` is a
    // launcher that forks `next-server`; killing only the launcher leaves the server holding the
    // port, and the next run then fails to bind with no useful message. Learned the hard way.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const web = spawn(
    'node',
    [join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--port', String(WEB_PORT)],
    {
      cwd: WEB,
      // `next start` sets its own `NODE_ENV`; forcing one here only risks disagreeing with it.
      env: { ...process.env, PORT: String(WEB_PORT) },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  /*
   * PHASE 7.1A — both servers' output to files, so a failure that only reproduces inside a full run
   * can be read afterwards rather than guessed at. The record-page timeout showed the route error
   * boundary with a correlation id and nothing else; the exception behind that id is in the API's
   * log and nowhere else.
   */
  const apiLog = createWriteStream('/tmp/e2e-api.log', { flags: 'w' });
  const webLog = createWriteStream('/tmp/e2e-web.log', { flags: 'w' });
  api.stdout?.pipe(apiLog);
  api.stderr?.pipe(apiLog);
  web.stdout?.pipe(webLog);
  web.stderr?.pipe(webLog);

  await Promise.all([
    waitForPort(`http://127.0.0.1:${String(API_PORT)}/api/v1/health`, api, 'API'),
    waitForPort(`${WEB_URL}/login`, web, 'web'),
  ]);
  return { api, web };
}

/**
 * Stops both servers, and then makes sure the ports are actually free.
 *
 * The group kill alone is not enough, which took a while to establish. `next start` forks
 * `next-server`, and killing the launcher's process group left the fork alive and holding 3210 —
 * so the *next* e2e file failed to bind and reported "something is already listening", blaming a
 * stranger for its own sibling. Killing whatever still holds the port is the check that closes it.
 */
export function stopServers(servers: Servers | null): void {
  killGroup(servers?.api.pid);
  killGroup(servers?.web.pid);
  freePort(API_PORT);
  freePort(WEB_PORT);
}

/** The whole group, because `next start` forks a server that outlives its launcher. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone, which is the outcome this wanted.
  }
}

/** Whoever is still listening on this port, gone. */
function freePort(port: number): void {
  try {
    const owners = execFileSync('fuser', ['-n', 'tcp', String(port)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const pid of owners.trim().split(/\s+/).filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  } catch {
    // `fuser` answers non-zero when nothing holds the port, which is the desired state.
  }
}

/**
 * A page already holding somebody's session, from cookies captured once.
 *
 * Signing in per test spends `auth.login`'s ten-per-five-minutes budget and turns later tests into
 * `429`s that surface as "the page never navigated". Capturing the state once is also closer to
 * what a person does: sign in, then work.
 */
export type StorageState = Awaited<ReturnType<import('playwright').BrowserContext['storageState']>>;

export async function signInAndCapture(
  browser: import('playwright').Browser,
  webUrl: string,
  email: string,
  password: string,
  tenant: string,
): Promise<StorageState> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${webUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Organisation').fill(tenant);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  const state = await context.storageState();
  await context.close();
  return state;
}

/**
 * Waits for a port to be free, and refuses if it stays taken.
 *
 * Two things at once, and both are needed. A leftover process answers health checks perfectly well
 * while serving a *different* tenant, so every assertion fails as authorization and the real cause
 * is nowhere in the output — hence the refusal. But two e2e files run one after another and the
 * departing suite's server takes a moment to release the socket, so failing on the first look
 * turns an ordinary handover into a red build. Waiting first, then refusing, keeps both.
 */
async function waitUntilFree(base: string, name: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(2_000) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Something is still listening on ${base} after 30s. This suite boots its own ${name} and ` +
      'would otherwise run against a stranger — with a different tenant, and every assertion ' +
      'failing as authorization. Stop it and run again.',
  );
}

/**
 * Waits for a server to answer, and fails loudly with its own output when it does not.
 *
 * The output matters more than the timeout: a server that refuses to boot because a variable is
 * missing prints exactly that, and a harness that swallowed it would report "timed out" for a
 * problem the process had already explained.
 */
async function waitForPort(url: string, child: ChildProcess, name: string): Promise<void> {
  const log: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()));

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The ${name} exited with ${String(child.exitCode)}:\n${log.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The ${name} did not answer ${url} within 90s:\n${log.join('')}`);
}
