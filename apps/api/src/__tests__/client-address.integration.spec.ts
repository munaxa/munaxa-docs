import 'reflect-metadata';

import { type IncomingHttpHeaders, type Server, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@edms/utils';

import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * The sign-in rate limit, keyed on the client rather than on whatever connected — the release
 * candidate's D-2.
 *
 * `auth.login` allows ten attempts per five minutes per address. Sign-in is a server action, so the
 * address the API saw was the web server's for every browser, and the eleventh person to sign in —
 * in any tenant — was refused. The same collapse happens behind any load balancer. These tests run
 * the real application on real sockets, with each client bound to its own loopback address (Linux
 * routes all of 127.0.0.0/8 to the loopback interface) and, for the proxied cases, a real forwarding
 * hop in between that appends to `X-Forwarded-For` the way nginx's `$proxy_add_x_forwarded_for` does.
 *
 * What they pin, in both directions:
 *
 * - distinct clients do not share an allowance, across tenants too;
 * - one client still gets exactly ten attempts, however it dresses them up;
 * - with no proxy trusted, a forged `X-Forwarded-For` changes nothing;
 * - with the proxy trusted, the address it reports is the one the limit and the session use, and
 *   a client still cannot choose its own by writing the header before the proxy appends to it.
 */

const ACME_APP_URL = process.env['DATABASE_URL'] ?? '';
const ACME_OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const RIVAL_APP_URL = process.env['SECOND_DATABASE_URL'] ?? '';
const RIVAL_OWNER_URL = process.env['SECOND_DATABASE_MIGRATION_URL'] ?? '';

const PASSWORD = 'correct horse battery staple';
const ACME = uuidv7();
const RIVAL = uuidv7();
const ACME_SLUG = `ca-${ACME.replaceAll('-', '').slice(-12)}`;
const RIVAL_SLUG = `cr-${RIVAL.replaceAll('-', '').slice(-12)}`;

/** Twelve people in one tenant — one more than the limit, and one spare. */
const ACME_PEOPLE = Array.from({ length: 12 }, (_, index) => `person${String(index)}@acme.test`);
const RIVAL_PEOPLE = ['first@rival.test', 'second@rival.test'];

/** The forwarding hop's own address — what `TRUST_PROXY` names in the proxied topology. */
const PROXY_ADDRESS = '127.0.0.250';

delete process.env['TENANT_ID'];
delete process.env['TENANT_SLUG'];
process.env['TENANT_CATALOGUE'] = JSON.stringify({
  tenants: [
    {
      id: ACME,
      slug: ACME_SLUG,
      database: { url: ACME_APP_URL, migrationUrl: ACME_OWNER_URL },
      storage: { driver: 'LOCAL', container: 'munaxa-docs', prefix: ACME_SLUG },
      search: { index: `docs-${ACME_SLUG}` },
    },
    {
      id: RIVAL,
      slug: RIVAL_SLUG,
      database: { url: RIVAL_APP_URL, migrationUrl: RIVAL_OWNER_URL },
      storage: { driver: 'LOCAL', container: 'munaxa-docs', prefix: RIVAL_SLUG },
      search: { index: `docs-${RIVAL_SLUG}` },
    },
  ],
});

interface Reply {
  readonly status: number;
  readonly body: { code?: string; accessToken?: string } | null;
}

interface Attempt {
  readonly from: string;
  readonly tenant: string;
  readonly email: string;
  readonly password?: string;
  readonly forwardedFor?: string;
}

/** One sign-in, sent from `from` — a real socket bound to that address. */
function signInAt(port: number, attempt: Attempt): Promise<Reply> {
  const payload = JSON.stringify({
    email: attempt.email,
    password: attempt.password ?? PASSWORD,
    tenant: attempt.tenant,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
  };
  if (attempt.forwardedFor !== undefined) {
    headers['x-forwarded-for'] = attempt.forwardedFor;
  }
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        localAddress: attempt.from,
        method: 'POST',
        path: '/api/v1/auth/login',
        headers,
        agent: false,
      },
      (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => (text += chunk));
        incoming.on('end', () => {
          let body: Reply['body'] = null;
          try {
            body = JSON.parse(text) as Reply['body'];
          } catch {
            body = null;
          }
          resolve({ status: incoming.statusCode ?? 0, body });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

/**
 * A reverse proxy in the shape every real one has: it connects onward from its own address and
 * appends the address it received the request from to whatever `X-Forwarded-For` arrived.
 */
async function startProxy(upstreamPort: number): Promise<{ server: Server; port: number }> {
  const server = createServer((incoming, outgoing) => {
    const arrived = incoming.headers['x-forwarded-for'];
    const peer = incoming.socket.remoteAddress ?? '';
    const forwarded = arrived === undefined ? peer : `${String(arrived)}, ${peer}`;
    const headers: IncomingHttpHeaders = { ...incoming.headers, 'x-forwarded-for': forwarded };
    const upstream = request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        localAddress: PROXY_ADDRESS,
        method: incoming.method,
        path: incoming.url,
        headers,
        agent: false,
      },
      (reply) => {
        outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

async function boot(
  trustProxy: string | undefined,
): Promise<{ app: INestApplication; port: number }> {
  if (trustProxy === undefined) {
    delete process.env['TRUST_PROXY'];
  } else {
    process.env['TRUST_PROXY'] = trustProxy;
  }
  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../bootstrap');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  const address = server.address() as AddressInfo;
  return { app, port: address.port };
}

/** An empty limiter, so each topology starts from the same allowance and reruns do not inherit. */
async function clearLimiter(): Promise<void> {
  const { RedisCacheAdapter } = await import('../infrastructure/cache/redis-cache.adapter');
  const { loadConfig } = await import('../core/config/configuration');
  const cache = new RedisCacheAdapter(loadConfig());
  await cache.deleteByPrefix('rl:');
  await cache.onModuleDestroy();
}

/** The address the product recorded for the newest session of this person. */
async function recordedAddress(
  client: PrismaClient,
  tenantId: string,
  email: string,
): Promise<string | null> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    const user = await tx.user.findFirstOrThrow({ where: { tenantId, emailNormalized: email } });
    const family = await tx.sessionFamily.findFirst({
      where: { tenantId, userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return family?.ipAddress ?? null;
  });
}

async function seed(
  client: PrismaClient,
  tenantId: string,
  slug: string,
  people: readonly string[],
): Promise<void> {
  const passwordHash = await new ScryptPasswordHasher().hash(PASSWORD);
  await client.tenant.create({ data: { id: tenantId, slug, name: slug, status: 'ACTIVE' } });
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    for (const email of people) {
      await tx.user.create({
        data: {
          id: uuidv7(),
          tenantId,
          email,
          emailNormalized: email,
          displayName: email,
          status: 'ACTIVE',
          passwordHash,
          passwordAlgorithm: 'SCRYPT',
        },
      });
    }
  });
}

let acme: PrismaClient;
let rival: PrismaClient;

beforeAll(async () => {
  if (!ACME_OWNER_URL || !RIVAL_OWNER_URL || !ACME_APP_URL || !RIVAL_APP_URL) {
    throw new Error('Both tenant databases, application and owner URLs, must be set.');
  }
  acme = new PrismaClient({ datasources: { db: { url: ACME_OWNER_URL } } });
  rival = new PrismaClient({ datasources: { db: { url: RIVAL_OWNER_URL } } });
  await seed(acme, ACME, ACME_SLUG, ACME_PEOPLE);
  await seed(rival, RIVAL, RIVAL_SLUG, RIVAL_PEOPLE);
}, 120_000);

afterAll(async () => {
  delete process.env['TRUST_PROXY'];
  await acme?.$disconnect();
  await rival?.$disconnect();
});

describe('with no proxy trusted — a direct deployment, the default', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    await clearLimiter();
    ({ app, port } = await boot(undefined));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('lets eleven people at eleven addresses sign in: the eleventh is not refused', async () => {
    for (const [index, email] of ACME_PEOPLE.slice(0, 11).entries()) {
      const reply = await signInAt(port, {
        from: `127.0.1.${String(index + 1)}`,
        tenant: ACME_SLUG,
        email,
      });
      expect(reply.status, `${email} from 127.0.1.${String(index + 1)}`).toBe(200);
      expect(typeof reply.body?.accessToken).toBe('string');
    }
  });

  it('still gives one address exactly ten attempts, across as many identities as it likes', async () => {
    const from = '127.0.2.1';
    for (let attempt = 0; attempt < 10; attempt++) {
      const reply = await signInAt(port, {
        from,
        tenant: ACME_SLUG,
        email: `nobody${String(attempt)}@acme.test`,
        password: 'wrong',
      });
      expect(reply.status).toBe(401);
    }
    // The eleventh is refused even with a real person's right password: the address is spent.
    const eleventh = await signInAt(port, {
      from,
      tenant: ACME_SLUG,
      email: ACME_PEOPLE[11] ?? '',
    });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body?.code).toBe('RATE_LIMITED');
  });

  it("does not spend another tenant's client's allowance when one client exhausts its own", async () => {
    const clientA = '127.0.3.1';
    const clientB = '127.0.3.2';
    for (let attempt = 0; attempt < 10; attempt++) {
      await signInAt(port, {
        from: clientA,
        tenant: ACME_SLUG,
        email: `stranger${String(attempt)}@acme.test`,
        password: 'wrong',
      });
    }
    const refused = await signInAt(port, {
      from: clientA,
      tenant: RIVAL_SLUG,
      email: RIVAL_PEOPLE[0] ?? '',
    });
    expect(refused.status).toBe(429);

    const admitted = await signInAt(port, {
      from: clientB,
      tenant: RIVAL_SLUG,
      email: RIVAL_PEOPLE[0] ?? '',
    });
    expect(admitted.status).toBe(200);
  });

  it('ignores a forged X-Forwarded-For: new claims each time buy no new attempts', async () => {
    const from = '127.0.4.1';
    for (let attempt = 0; attempt < 10; attempt++) {
      const reply = await signInAt(port, {
        from,
        tenant: ACME_SLUG,
        email: `forger${String(attempt)}@acme.test`,
        password: 'wrong',
        forwardedFor: `203.0.113.${String(attempt + 1)}`,
      });
      expect(reply.status).toBe(401);
    }
    const eleventh = await signInAt(port, {
      from,
      tenant: RIVAL_SLUG,
      email: RIVAL_PEOPLE[1] ?? '',
      forwardedFor: '198.51.100.99',
    });
    expect(eleventh.status).toBe(429);
  });

  it('records the connection, not the claim, as the session address', async () => {
    const reply = await signInAt(port, {
      from: '127.0.5.1',
      tenant: RIVAL_SLUG,
      email: RIVAL_PEOPLE[1] ?? '',
      forwardedFor: '198.51.100.23',
    });
    expect(reply.status).toBe(200);
    expect(await recordedAddress(rival, RIVAL, RIVAL_PEOPLE[1] ?? '')).toBe('127.0.5.1');
  });
});

describe('with the reverse proxy trusted by address — a load-balanced or web-fronted deployment', () => {
  let app: INestApplication;
  let port: number;
  let proxy: { server: Server; port: number };

  beforeAll(async () => {
    await clearLimiter();
    ({ app, port } = await boot(PROXY_ADDRESS));
    proxy = await startProxy(port);
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => proxy?.server.close(resolve));
    await app?.close();
  });

  it('lets eleven people behind the one proxy sign in, each on their own allowance', async () => {
    for (const [index, email] of ACME_PEOPLE.slice(0, 11).entries()) {
      const from = `127.0.6.${String(index + 1)}`;
      const reply = await signInAt(proxy.port, { from, tenant: ACME_SLUG, email });
      expect(reply.status, `${email} from ${from} through the proxy`).toBe(200);
    }
  });

  it('records the address the proxy reported, not the proxy', async () => {
    const reply = await signInAt(proxy.port, {
      from: '127.0.7.1',
      tenant: RIVAL_SLUG,
      email: RIVAL_PEOPLE[0] ?? '',
    });
    expect(reply.status).toBe(200);
    expect(await recordedAddress(rival, RIVAL, RIVAL_PEOPLE[0] ?? '')).toBe('127.0.7.1');
  });

  it('keeps ten attempts per client behind the proxy, and across tenants the next client is untouched', async () => {
    const clientA = '127.0.8.1';
    for (let attempt = 0; attempt < 10; attempt++) {
      const reply = await signInAt(proxy.port, {
        from: clientA,
        tenant: ACME_SLUG,
        email: `guess${String(attempt)}@acme.test`,
        password: 'wrong',
      });
      expect(reply.status).toBe(401);
    }
    const refused = await signInAt(proxy.port, {
      from: clientA,
      tenant: RIVAL_SLUG,
      email: RIVAL_PEOPLE[1] ?? '',
    });
    expect(refused.status).toBe(429);

    const admitted = await signInAt(proxy.port, {
      from: '127.0.8.2',
      tenant: RIVAL_SLUG,
      email: RIVAL_PEOPLE[1] ?? '',
    });
    expect(admitted.status).toBe(200);
  });

  it('does not let a client choose its address by writing the header the proxy appends to', async () => {
    const from = '127.0.9.1';
    for (let attempt = 0; attempt < 10; attempt++) {
      await signInAt(proxy.port, {
        from,
        tenant: ACME_SLUG,
        email: `mask${String(attempt)}@acme.test`,
        password: 'wrong',
        forwardedFor: `203.0.113.${String(attempt + 1)}`,
      });
    }
    const eleventh = await signInAt(proxy.port, {
      from,
      tenant: ACME_SLUG,
      email: ACME_PEOPLE[11] ?? '',
      forwardedFor: '198.51.100.77',
    });
    expect(eleventh.status).toBe(429);
  });

  it('does not trust the header from a client that bypasses the proxy and connects directly', async () => {
    const from = '127.0.10.1';
    for (let attempt = 0; attempt < 10; attempt++) {
      await signInAt(port, {
        from,
        tenant: ACME_SLUG,
        email: `direct${String(attempt)}@acme.test`,
        password: 'wrong',
        forwardedFor: `203.0.113.${String(attempt + 1)}`,
      });
    }
    const eleventh = await signInAt(port, {
      from,
      tenant: ACME_SLUG,
      email: ACME_PEOPLE[11] ?? '',
      forwardedFor: '198.51.100.78',
    });
    expect(eleventh.status).toBe(429);
  });
});
