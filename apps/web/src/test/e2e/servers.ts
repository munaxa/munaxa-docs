import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

export interface Fixture {
  readonly tenantId: string;
  readonly slug: string;
  readonly password: string;
  readonly signer: { readonly id: string; readonly email: string; readonly name: string };
  readonly reader: { readonly id: string; readonly email: string };
  readonly documentId: string;
  readonly revisionId: string;
  readonly revisionLabel: string;
  readonly documentNumber: string;
  readonly contentSha256: string;
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

export async function startServers(fixture: Fixture): Promise<Servers> {
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
  await refuseIfTaken(`http://127.0.0.1:${String(API_PORT)}`, 'API');
  await refuseIfTaken(WEB_URL, 'web');

  // `NODE_ENV` is deliberately **not** forced to `production` here. The API's configuration
  // hardens in production — it refuses `STORAGE_DRIVER=NONE`, demands a TOTP sealing key and an
  // audit checkpoint secret — and those refusals are correct behaviour that this suite has no
  // business disabling by supplying secrets it invented. It runs the shipped *artefact* under the
  // test profile, which is the same thing the integration suites do.
  const apiEnv = { ...process.env };
  delete apiEnv.TENANT_CATALOGUE;
  delete apiEnv.TENANT_CATALOGUE_PATH;

  const api = spawn('node', [main], {
    cwd: API,
    env: {
      ...apiEnv,
      PORT: String(API_PORT),
      LOG_LEVEL: 'fatal',
      // One tenant, named by the fixture — the on-premise shape, and the only one this suite needs.
      TENANT_ID: fixture.tenantId,
      TENANT_SLUG: fixture.slug,
      SIGNATURE_WITNESS_SECRET: WITNESS_SECRET,
      CORS_ORIGINS: WEB_URL,
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

  await Promise.all([
    waitForPort(`http://127.0.0.1:${String(API_PORT)}/api/v1/health`, api, 'API'),
    waitForPort(`${WEB_URL}/login`, web, 'web'),
  ]);
  return { api, web };
}

export function stopServers(servers: Servers | null): void {
  killGroup(servers?.api.pid);
  killGroup(servers?.web.pid);
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

async function refuseIfTaken(base: string, name: string): Promise<void> {
  try {
    await fetch(base, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return;
  }
  throw new Error(
    `Something is already listening on ${base}. This suite boots its own ${name} and would ` +
      'otherwise run against a stranger — with a different tenant, and every assertion failing ' +
      'as authorization. Stop it and run again.',
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
