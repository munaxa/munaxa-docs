import 'reflect-metadata';

import { request as httpRequest } from 'node:http';

import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { totpCode } from '../modules/identity/domain/totp';
import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * Which tenant a sign-in reaches, over HTTP, when the product is served at its own hostname.
 *
 * Every organisation signs in at `docs.munaxa.com`, and the API may sit at `api.docs.munaxa.com`.
 * The sign-in routes used to fall back to the leftmost label of the host when the form named no
 * organisation, so a blank field on either host became the slug `docs` or `api` — a product name,
 * never a customer's. That was a failed sign-in at best, and at worst a sign-in to whichever tenant
 * happened to carry that slug.
 *
 * So the two tenants here are deliberately called `docs` and `api`, and the same address and
 * password exist in both. With the old rule, a blank tenant at either host would authenticate; the
 * assertions below would then fail on the status rather than on a fixture that could not tell.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const SECOND_OWNER_URL = process.env['SECOND_DATABASE_MIGRATION_URL'] ?? '';
const SECOND_APP_URL = process.env['SECOND_DATABASE_URL'] ?? '';

const PASSWORD = 'correct horse battery staple';

/** Fixed, so a re-run finds the tenant rows it created last time rather than colliding on slug. */
const DOCS_TENANT = { id: '019489f0-0000-7000-8000-00000000d0c5', slug: 'docs' } as const;
const API_TENANT = { id: '019489f0-0000-7000-8000-0000000000a9', slug: 'api' } as const;

/** Fresh per run, so a re-run never meets an account an earlier run enrolled in MFA. */
const run = uuidv7().replaceAll('-', '').slice(-12);
const email = `ada-${run}@tenant-resolution.test`;
const mfaEmail = `grace-${run}@tenant-resolution.test`;

/*
 * The cloud shape — a catalogue of two — set before the application is composed, and the
 * single-tenant variables cleared so this suite cannot inherit another's tenancy.
 */
delete process.env['TENANT_ID'];
delete process.env['TENANT_SLUG'];
delete process.env['TENANT_CATALOGUE_PATH'];
process.env['TENANT_CATALOGUE'] = JSON.stringify({
  tenants: [DOCS_TENANT, API_TENANT].map((tenant, index) => ({
    ...tenant,
    database:
      index === 0
        ? { url: APP_URL, migrationUrl: OWNER_URL }
        : { url: SECOND_APP_URL, migrationUrl: SECOND_OWNER_URL },
    storage: { driver: 'LOCAL', container: 'munaxa-docs', prefix: `tenants/${tenant.slug}` },
    search: { index: `docs-${tenant.slug}` },
  })),
});

let app: INestApplication;
let port: number;

interface Response<TBody> {
  readonly status: number;
  readonly body: TBody;
}
interface AuthBody {
  accessToken: string;
  refreshToken: string;
}
interface ProblemBody {
  code: string;
}
interface MeBody {
  tenantId: string;
}

/**
 * A request with a chosen `Host`, which `fetch` will not send — it is a forbidden header there. The
 * host is what the defect read, so it is what these tests have to control.
 */
function call<TBody>(
  method: 'GET' | 'POST',
  host: string,
  path: string,
  options: { body?: unknown; accessToken?: string } = {},
): Promise<Response<TBody>> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: host,
          ...(payload !== undefined && {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
          ...(options.accessToken !== undefined && {
            Authorization: `Bearer ${options.accessToken}`,
          }),
        },
      },
      (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => (text += chunk));
        incoming.on('end', () => {
          let body: unknown = null;
          try {
            body = text === '' ? null : JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: incoming.statusCode ?? 0, body: body as TBody });
        });
      },
    );
    outgoing.on('error', reject);
    if (payload !== undefined) {
      outgoing.write(payload);
    }
    outgoing.end();
  });
}

const login = (host: string, body: Record<string, string>) =>
  call<AuthBody & ProblemBody>('POST', host, '/api/v1/auth/login', { body });

/** One tenant row, one role and the given accounts, in one tenant database. Idempotent on re-run. */
async function seed(
  url: string,
  tenant: { id: string; slug: string },
  accounts: readonly string[],
): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url } } });
  const passwordHash = await new ScryptPasswordHasher().hash(PASSWORD);
  const roleId = uuidv7();
  try {
    await owner.tenant.upsert({
      where: { id: tenant.id },
      create: { id: tenant.id, slug: tenant.slug, name: `Tenant ${tenant.slug}`, status: 'ACTIVE' },
      update: {},
    });
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenant.id);
      await tx.role.create({
        data: {
          id: roleId,
          tenantId: tenant.id,
          key: `TENANT_RESOLUTION_${run.toUpperCase()}`,
          name: 'Tenant resolution fixture',
          isSystem: false,
          // What the authenticator screen asks for (`MfaController`); nothing else is needed.
          permissions: {
            create: [{ tenantId: tenant.id, permission: Permission.NOTIFICATION_MANAGE }],
          },
        },
      });
      for (const address of accounts) {
        await tx.user.create({
          data: {
            id: uuidv7(),
            tenantId: tenant.id,
            email: address,
            emailNormalized: address,
            displayName: 'Tenant Resolution',
            status: 'ACTIVE',
            passwordHash,
            passwordAlgorithm: 'SCRYPT',
            roles: { create: [{ tenantId: tenant.id, roleId }] },
          },
        });
      }
    });
  } finally {
    await owner.$disconnect();
  }
}

/**
 * A clean limiter, as in auth.e2e: `auth.login` allows ten attempts per address per window and every
 * request here comes from one address, so the two groups below would otherwise share one budget.
 */
async function clearSignInLimiter(): Promise<void> {
  const { RedisCacheAdapter } = await import('../infrastructure/cache/redis-cache.adapter');
  const { loadConfig } = await import('../core/config/configuration');
  const cache = new RedisCacheAdapter(loadConfig());
  await cache.deleteByPrefix('rl:');
  await cache.onModuleDestroy();
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL || !SECOND_OWNER_URL || !SECOND_APP_URL) {
    throw new Error(
      'DATABASE_URL, DATABASE_MIGRATION_URL, SECOND_DATABASE_URL and SECOND_DATABASE_MIGRATION_URL ' +
        'must all be set: this suite needs two tenant databases.',
    );
  }

  // The same address and password in both tenants, so only the tenant decides where a sign-in goes.
  await seed(OWNER_URL, DOCS_TENANT, [email, mfaEmail]);
  await seed(SECOND_OWNER_URL, API_TENANT, [email]);

  await clearSignInLimiter();

  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../bootstrap');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0);
  port = Number(new URL(await app.getUrl()).port);
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('tenant resolution at sign-in, on the product hostname', () => {
  it('does not sign a blank tenant at docs.munaxa.com into the tenant called "docs"', async () => {
    const { status, body } = await login('docs.munaxa.com', { email, password: PASSWORD });

    expect(status).toBe(401);
    expect(body.accessToken).toBeUndefined();
  });

  it('does not sign a blank tenant at api.docs.munaxa.com into the tenant called "api"', async () => {
    const { status, body } = await login('api.docs.munaxa.com', { email, password: PASSWORD });

    expect(status).toBe(401);
    expect(body.accessToken).toBeUndefined();
  });

  it('refuses a blank tenant the same way as a wrong password — no hint which field was missing', async () => {
    const blank = await login('docs.munaxa.com', { email, password: PASSWORD });
    const wrong = await login('docs.munaxa.com', {
      email,
      password: 'not the password',
      tenant: DOCS_TENANT.slug,
    });

    expect(blank.status).toBe(wrong.status);
    expect(blank.body.code).toBe(wrong.body.code);
  });

  it('signs a named tenant in at docs.munaxa.com, into that tenant', async () => {
    const { status, body } = await login('docs.munaxa.com', {
      email,
      password: PASSWORD,
      tenant: DOCS_TENANT.slug,
    });
    expect(status).toBe(200);

    const me = await call<MeBody>('GET', 'docs.munaxa.com', '/api/v1/auth/me', {
      accessToken: body.accessToken,
    });
    expect(me.status).toBe(200);
    expect(me.body.tenantId).toBe(DOCS_TENANT.id);
  });

  it('lets the named tenant decide at the API host, whatever the host says', async () => {
    // The API host's own label is `api`, and a tenant with that slug exists. Naming `docs` there must
    // still reach `docs`: the host is not an input at all, in either direction.
    const { status, body } = await login('api.docs.munaxa.com', {
      email,
      password: PASSWORD,
      tenant: DOCS_TENANT.slug,
    });
    expect(status).toBe(200);

    const me = await call<MeBody>('GET', 'api.docs.munaxa.com', '/api/v1/auth/me', {
      accessToken: body.accessToken,
    });
    expect(me.body.tenantId).toBe(DOCS_TENANT.id);
  });

  it('keeps an ordinary named-tenant sign-in and refresh working on a host with no product label', async () => {
    const signedIn = await login('127.0.0.1', {
      email,
      password: PASSWORD,
      tenant: API_TENANT.slug,
    });
    expect(signedIn.status).toBe(200);

    const refreshed = await call<AuthBody>('POST', '127.0.0.1', '/api/v1/auth/refresh', {
      body: { refreshToken: signedIn.body.refreshToken, tenant: API_TENANT.slug },
    });
    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.body.accessToken).toBe('string');
  });

  it('does not refresh a session against a tenant guessed from the host', async () => {
    const signedIn = await login('docs.munaxa.com', {
      email,
      password: PASSWORD,
      tenant: DOCS_TENANT.slug,
    });
    expect(signedIn.status).toBe(200);

    // Before the fix this resolved `docs` from the host and succeeded without naming a tenant.
    const refreshed = await call<ProblemBody>('POST', 'docs.munaxa.com', '/api/v1/auth/refresh', {
      body: { refreshToken: signedIn.body.refreshToken },
    });
    expect(refreshed.status).toBe(401);
  });
});

describe('the second factor and federated discovery still reach the named tenant', () => {
  beforeAll(clearSignInLimiter);

  it('asks for the TOTP code once the password is right, and accepts a recovery code', async () => {
    const first = await login('docs.munaxa.com', {
      email: mfaEmail,
      password: PASSWORD,
      tenant: DOCS_TENANT.slug,
    });
    expect(first.status).toBe(200);

    const offer = await call<{ secret: string; digits: number; stepSeconds: number }>(
      'POST',
      'docs.munaxa.com',
      '/api/v1/auth/mfa/enrolment',
      { accessToken: first.body.accessToken },
    );
    expect(offer.status).toBe(200);

    const step = Math.floor(Date.now() / 1000 / offer.body.stepSeconds);
    const confirmed = await call<{ recoveryCodes: string[] }>(
      'POST',
      'docs.munaxa.com',
      '/api/v1/auth/mfa/enrolment/confirm',
      {
        accessToken: first.body.accessToken,
        body: { code: totpCode(offer.body.secret, step, offer.body.digits) },
      },
    );
    expect(confirmed.status).toBe(200);
    const recoveryCode = confirmed.body.recoveryCodes[0];
    expect(typeof recoveryCode).toBe('string');

    const withoutCode = await login('docs.munaxa.com', {
      email: mfaEmail,
      password: PASSWORD,
      tenant: DOCS_TENANT.slug,
    });
    expect(withoutCode.status).toBe(401);
    expect(withoutCode.body.code).toBe('MFA_REQUIRED');

    const withCode = await login('docs.munaxa.com', {
      email: mfaEmail,
      password: PASSWORD,
      tenant: DOCS_TENANT.slug,
      mfaCode: recoveryCode ?? '',
    });
    expect(withCode.status).toBe(200);
  });

  it('accepts the named tenant on the discovery question, and offers nothing for a guessed one', async () => {
    // Neither fixture tenant has switched federation on, so both answers are "not federated". What
    // this pins is that the sign-in screen can name its organisation to this route at all — before,
    // the only tenant it could ask about was the one the host named.
    const named = await call<{ federated: boolean }>(
      'GET',
      'docs.munaxa.com',
      `/api/v1/auth/federation?email=${encodeURIComponent(email)}&tenant=${DOCS_TENANT.slug}`,
    );
    expect(named.status).toBe(200);
    expect(named.body.federated).toBe(false);

    const guessed = await call<{ federated: boolean }>(
      'GET',
      'docs.munaxa.com',
      `/api/v1/auth/federation?email=${encodeURIComponent(email)}`,
    );
    expect(guessed.status).toBe(200);
    expect(guessed.body.federated).toBe(false);
  });
});
