import { execFileSync } from 'node:child_process';
import { type Server, connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { en } from '@edms/i18n';

import {
  type Fixture,
  type Servers,
  WEB_PORT,
  cleanUpFixtures,
  seedFixture,
  startServers,
  stopServers,
} from './servers';

/**
 * Sign-in through the real `/login` server action, from many browsers — the release candidate's D-2.
 *
 * Sign-in is a server action, so the API used to see the web server as the client for every browser,
 * and the sign-in limit (ten per five minutes per address) was spent by the whole deployment at once:
 * ten people signed in and the eleventh — in any tenant — was told sign-in was unavailable. Now the
 * web server resolves the browser's address from its own socket (`server.mjs`) and forwards it, and
 * the API believes it because the harness names the web server's hop in `TRUST_PROXY`.
 *
 * A browser cannot choose its source address, so each person here reaches the web server through a
 * TCP relay of their own that connects onward from a distinct loopback address — exactly what the
 * web server would see from distinct machines. The browser, the server action, the API, Redis and
 * PostgreSQL are all the real ones; what is asserted is what the product did, including the address
 * the API recorded against each session.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** One more than the limit, so the eleventh is the one the defect refused. */
const PEOPLE = Array.from({ length: 11 }, (_, index) => `walker${String(index + 1)}@e2e.test`);

let fixture: Fixture;
let servers: Servers | null = null;
let browser: Browser;
const relays: Server[] = [];

/** A relay that makes whoever connects to it arrive at the web server from `address`. */
async function relayFrom(address: string): Promise<number> {
  const relay = createServer((inbound) => {
    const outbound = connect({ host: '127.0.0.1', port: WEB_PORT, localAddress: address });
    inbound.pipe(outbound).pipe(inbound);
    inbound.on('error', () => outbound.destroy());
    outbound.on('error', () => inbound.destroy());
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  relays.push(relay);
  return (relay.address() as AddressInfo).port;
}

type Outcome = 'SIGNED_IN' | 'UNAVAILABLE' | 'REJECTED';

/** One person at the sign-in form, in a browser of their own, through the relay at `port`. */
async function signInThrough(
  port: number,
  person: { email: string; password: string; tenant: string },
  extraHTTPHeaders: Record<string, string> = {},
): Promise<Outcome> {
  const context = await browser.newContext({ extraHTTPHeaders });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${String(port)}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email address').fill(person.email);
    await page.getByLabel('Password').fill(person.password);
    await page.getByLabel('Organisation').fill(person.tenant);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // The form's own message: Next.js's route announcer is also `role="alert"`.
    const alert = page.locator('form').getByRole('alert');
    const outcome = await Promise.race([
      page
        .waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })
        .then(() => 'SIGNED_IN' as const),
      alert.waitFor({ state: 'visible', timeout: 30_000 }).then(async () => {
        const text = await alert.innerText();
        return text.includes(en.auth.signInUnavailable)
          ? ('UNAVAILABLE' as const)
          : ('REJECTED' as const);
      }),
    ]);
    return outcome;
  } finally {
    await context.close();
  }
}

/**
 * Empties this suite's own Redis database, so the allowances under test start full.
 *
 * `startServers` gives each suite a logical database by position, so a rerun inside the five-minute
 * window would otherwise inherit the last run's counters and find its "fresh" address already spent.
 * The suite owns that precondition, as `auth.e2e.integration.spec.ts` does. Two commands of RESP,
 * spoken directly, rather than a client library this app does not otherwise depend on.
 */
async function emptyRedis(redisUrl: string): Promise<void> {
  const url = new URL(redisUrl);
  const database = url.pathname.replace('/', '') || '0';
  const command = (...parts: string[]): string =>
    `*${String(parts.length)}\r\n${parts.map((part) => `$${String(Buffer.byteLength(part))}\r\n${part}\r\n`).join('')}`;
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 6379) });
    let replies = '';
    socket.on('data', (chunk) => {
      replies += chunk.toString('utf8');
      if ((replies.match(/\r\n/g) ?? []).length >= 2) {
        socket.end();
        if (
          replies
            .split('\r\n')
            .slice(0, 2)
            .every((line) => line === '+OK')
        ) {
          resolve();
        } else {
          reject(new Error(`Redis refused: ${replies}`));
        }
      }
    });
    socket.on('error', reject);
    socket.write(command('SELECT', database) + command('FLUSHDB'));
  });
}

/** Runs statements in one transaction as the owner, with the tenant set for row-level security. */
function sql(
  databaseUrl: string,
  tenantId: string,
  statements: readonly { text: string; params?: readonly string[] }[],
): Record<string, string>[] {
  const calls = statements
    .map(
      (statement) =>
        `c.$queryRawUnsafe(${JSON.stringify(statement.text)}${(statement.params ?? [])
          .map((param) => `,${JSON.stringify(param)}`)
          .join('')})`,
    )
    .join(',');
  const script =
    "const {PrismaClient}=require('@prisma/client');" +
    `const c=new PrismaClient({datasources:{db:{url:${JSON.stringify(databaseUrl)}}}});` +
    `c.$transaction([c.$queryRawUnsafe("SELECT set_config('app.tenant_id',$1,true)::text AS t",${JSON.stringify(tenantId)}),${calls}])` +
    '.then(r=>{process.stdout.write(JSON.stringify(r[r.length-1]));return c.$disconnect()})' +
    '.catch(e=>{console.error(e);process.exit(1)});';
  const out = execFileSync('node', ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return JSON.parse(out) as Record<string, string>[];
}

/** The address the API recorded for this person's newest session. */
function sessionAddress(databaseUrl: string, tenantId: string, email: string): string | null {
  const rows = sql(databaseUrl, tenantId, [
    {
      text:
        'SELECT f.ip_address FROM session_family f JOIN "user" u ON u.id = f.user_id ' +
        'WHERE u.tenant_id = $1::uuid AND u.email_normalized = $2 ORDER BY f.created_at DESC LIMIT 1',
      params: [tenantId, email],
    },
  ]);
  return rows[0]?.['ip_address'] ?? null;
}

beforeAll(async () => {
  fixture = seedFixture();
  // Eleven more people, each a copy of the signer: same password, same role. Enough that no identity
  // is signed in twice, so the only allowance under test is the per-address one.
  const url = process.env.DATABASE_MIGRATION_URL ?? '';
  sql(
    url,
    fixture.tenantId,
    PEOPLE.flatMap((email) => [
      {
        text:
          'INSERT INTO "user" (id, tenant_id, email, email_normalized, display_name, status, ' +
          'password_hash, password_algorithm, updated_at) ' +
          'SELECT gen_random_uuid(), tenant_id, $2, $2, $2, status, password_hash, password_algorithm, now() ' +
          'FROM "user" WHERE id = $1::uuid',
        params: [fixture.signer.id, email],
      },
      {
        text:
          'INSERT INTO user_role (tenant_id, user_id, role_id) ' +
          'SELECT r.tenant_id, u.id, r.role_id FROM user_role r, "user" u ' +
          'WHERE r.user_id = $1::uuid AND u.tenant_id = r.tenant_id AND u.email_normalized = $2',
        params: [fixture.signer.id, email],
      },
    ]),
  );
  servers = await startServers(fixture);
  await emptyRedis(servers.redisUrl);
  browser = await chromium.launch(
    existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {},
  );
}, 300_000);

afterAll(async () => {
  for (const relay of relays) {
    relay.close();
  }
  await browser?.close();
  stopServers(servers);
  cleanUpFixtures();
});

describe('signing in through the web, from many browsers', () => {
  it('signs in eleven people from eleven addresses, and records each one’s own address', async () => {
    for (const [index, email] of PEOPLE.entries()) {
      const address = `127.0.40.${String(index + 1)}`;
      const outcome = await signInThrough(await relayFrom(address), {
        email,
        password: fixture.password,
        tenant: fixture.slug,
      });
      expect(outcome, `${email} from ${address}`).toBe('SIGNED_IN');
      expect(
        sessionAddress(process.env.DATABASE_MIGRATION_URL ?? '', fixture.tenantId, email),
      ).toBe(address);
    }
  }, 300_000);

  it('still refuses the eleventh attempt from one browser, and leaves another tenant’s browser alone', async () => {
    const exhausted = await relayFrom('127.0.41.1');
    for (let attempt = 0; attempt < 10; attempt++) {
      const outcome = await signInThrough(exhausted, {
        email: `nobody${String(attempt)}@e2e.test`,
        password: 'not the password',
        tenant: fixture.slug,
      });
      expect(outcome).toBe('REJECTED');
    }
    const refused = await signInThrough(exhausted, {
      email: fixture.reader.email,
      password: fixture.password,
      tenant: fixture.slug,
    });
    expect(refused, 'the eleventh attempt from one address').toBe('UNAVAILABLE');

    const neighbour = fixture.neighbour;
    expect(neighbour, 'this test needs the second tenant (SECOND_DATABASE_URL)').not.toBeNull();
    if (neighbour === null) {
      return;
    }
    const other = await relayFrom('127.0.41.2');
    const admitted = await signInThrough(other, {
      email: neighbour.email,
      password: fixture.password,
      tenant: neighbour.slug,
    });
    expect(admitted, 'a different browser, in a different tenant').toBe('SIGNED_IN');
    expect(
      sessionAddress(
        process.env.SECOND_DATABASE_MIGRATION_URL ?? '',
        neighbour.tenantId,
        neighbour.email,
      ),
    ).toBe('127.0.41.2');
  }, 300_000);

  it('does not let a browser choose its own address with forwarding headers', async () => {
    const relay = await relayFrom('127.0.42.1');
    for (let attempt = 0; attempt < 10; attempt++) {
      const forged = `203.0.113.${String(attempt + 1)}`;
      const outcome = await signInThrough(
        relay,
        {
          email: `forger${String(attempt)}@e2e.test`,
          password: 'not the password',
          tenant: fixture.slug,
        },
        { 'X-Forwarded-For': forged, 'X-Munaxa-Client-Address': forged },
      );
      expect(outcome).toBe('REJECTED');
    }
    const eleventh = await signInThrough(
      relay,
      { email: fixture.auditor.email, password: fixture.password, tenant: fixture.slug },
      { 'X-Forwarded-For': '198.51.100.9', 'X-Munaxa-Client-Address': '198.51.100.9' },
    );
    expect(eleventh, 'new forged addresses buy no new attempts').toBe('UNAVAILABLE');

    const fresh = await relayFrom('127.0.42.2');
    const signedIn = await signInThrough(
      fresh,
      { email: fixture.controller.email, password: fixture.password, tenant: fixture.slug },
      { 'X-Forwarded-For': '198.51.100.10', 'X-Munaxa-Client-Address': '198.51.100.10' },
    );
    expect(signedIn).toBe('SIGNED_IN');
    expect(
      sessionAddress(
        process.env.DATABASE_MIGRATION_URL ?? '',
        fixture.tenantId,
        fixture.controller.email,
      ),
    ).toBe('127.0.42.2');
  }, 300_000);
});
