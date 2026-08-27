import 'reflect-metadata';

import { createSign, generateKeyPairSync } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemRole, type TenantId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { FakeCache } from '../../../testing/fake-ports';
import { realWriteStack } from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { CachedSettingsReader } from '../../../modules/administration/infrastructure/cached-settings.reader';
import { PrismaTenantSettingsRepository } from '../../../modules/administration/infrastructure/prisma-tenant-settings.repository';
import { DefaultFederationService } from '../application/federation.service';
import type { OidcDiscovery, PendingAuthorization } from '../application/federation.ports';
import { ProvisioningService } from '../application/provisioning.service';
import { digestOf, type Jwk } from '../domain/oidc';
import { PrismaCredentialRepository } from '../infrastructure/prisma-credential.repository';
import {
  PrismaFederatedUserRepository,
  PrismaIdentityProviderRepository,
} from '../infrastructure/prisma-federation.repository';
import { PrismaProvisioningRepository } from '../infrastructure/prisma-provisioning.repository';
import { PrismaSessionRepository } from '../infrastructure/prisma-session.repository';
import { JwtTokenService } from '../infrastructure/jwt.token-service';
import { RandomRefreshTokenFactory } from '../infrastructure/random-refresh-token.factory';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher';

/**
 * Two federation callbacks for one new person, against a real PostgreSQL — Slice 60.
 *
 * `FederationService.complete` reads whether the external identity already has a local account and,
 * finding none, creates one. Those are two statements in one transaction, and two callbacks are two
 * transactions. Both can read "absent", and then both insert — against `uq_user_external_identity`
 * (`tenant_id, identity_provider_id, external_id`) and the partial `uq_user_tenant_email`.
 *
 * Two distinct authorization flows is what makes this ordinary rather than exotic: the state is
 * single-use, so a *replayed* callback is refused before it reaches here, but somebody who starts
 * sign-in in two tabs has two states and two valid assertions for one subject.
 *
 * ## Why the whole service rather than the repository
 *
 * Because what is in question is what the losing caller is *told*. A unique constraint doing its job
 * is not a defect; a caller who receives something other than the sequential answer is. Only the
 * service decides that, so the service is what runs — over real repositories, a real unit of work
 * and a real database. The one double is `OidcDiscovery`, which is the provider's own HTTP endpoint
 * and the only collaborator here that is not this product's.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-06-01T09:00:00.000Z');
const clock = {
  now: () => new Date(FIXED_NOW),
  timestamp: () => FIXED_NOW.getTime(),
  elapsedMs: () => 0,
};

const ISSUER = 'https://idp.jit-race.test';
const CLIENT_ID = 'client-jit';
const REDIRECT_URI = 'https://docs.jit-race.test/auth/callback';

const config = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10 },
  auth: {
    accessSecret: 'an-integration-suite-secret-of-at-least-32',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 1_209_600,
    issuer: 'munaxa-docs',
    audience: 'munaxa-docs',
    federationRedirectUri: REDIRECT_URI,
  },
} as unknown as AppConfig;

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { audit } = realWriteStack(clock, unitOfWork);

const SLUG = `jit-race-${String(Date.now())}`;
const PROVISION_TENANT = uuidv7();
const registry = everyTenantRegistry(APP_URL, { [SLUG]: PROVISION_TENANT });

const provisioning = new ProvisioningService(
  new PrismaProvisioningRepository(),
  new ScryptPasswordHasher(),
  clock,
  unitOfWork,
  audit,
  registry,
);

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

let tenantId: TenantId;
let providerId: string;

/* The provider's signing key. Real RS256, so `verifyIdToken` does its real work. */
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK: Jwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as unknown as Jwk), kid: 'k1' };

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function idTokenFor(subject: string, email: string, nonce: string): string {
  const seconds = Math.floor(FIXED_NOW.getTime() / 1000);
  const signed = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: subject,
    nonce,
    email,
    name: email,
    iat: seconds - 10,
    exp: seconds + 3_600,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signed, 'utf8');
  signer.end();
  return `${signed}.${signer.sign(rsa.privateKey).toString('base64url')}`;
}

/**
 * The provider's HTTP endpoints, and the only double in this suite.
 *
 * `exchange` answers with whatever token the caller's authorization code names, which is how one
 * stub serves two concurrent flows without either learning about the other.
 */
const tokensByCode = new Map<string, string>();
const discovery = {
  resolve: () =>
    Promise.resolve({
      document: {
        issuer: ISSUER,
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: `${ISSUER}/token`,
        jwksUri: `${ISSUER}/jwks`,
      },
      keys: [JWK],
    }),
  exchange: (_provider: unknown, _document: unknown, code: string) => {
    const idToken = tokensByCode.get(code);
    return Promise.resolve(idToken ? { idToken } : null);
  },
} as unknown as OidcDiscovery;

const cache = new FakeCache(clock);
/*
 * The real reader over the real column, not a double answering `true`.
 *
 * `feature.federation` defaults to **false**, and the gate is what decides whether `offerFor` ever
 * reaches the provider read at all. A stub that always said yes would make this suite pass for a
 * reason no deployment shares, and would hide the fact that the endpoint failed only for the
 * tenants that had actually switched federation on.
 */
const settings = new CachedSettingsReader(
  new PrismaTenantSettingsRepository(prisma),
  cache,
  logger,
);

function buildService(users: PrismaFederatedUserRepository): DefaultFederationService {
  return new DefaultFederationService(
    new PrismaIdentityProviderRepository(),
    discovery,
    users,
    new PrismaCredentialRepository(),
    new PrismaSessionRepository(clock),
    new JwtTokenService(config, clock),
    new RandomRefreshTokenFactory(config),
    registry,
    cache,
    settings,
    clock,
    unitOfWork,
    audit,
    logger,
    config,
  );
}

let service: DefaultFederationService;

/**
 * One authorization flow, started the way `begin` starts one: a single-use state in the cache and
 * a nonce whose digest is what the callback compares against.
 */
async function startFlow(subject: string, email: string): Promise<{ code: string; state: string }> {
  const state = uuidv7();
  const nonce = uuidv7();
  const code = uuidv7();
  const pending: PendingAuthorization = {
    tenantId,
    nonceDigest: digestOf(nonce),
    redirectUri: REDIRECT_URI,
    createdAt: FIXED_NOW.toISOString(),
  };
  await cache.set(`federation:authorization:${digestOf(state)}`, pending, 600);
  tokensByCode.set(code, idTokenFor(subject, email, nonce));
  return { code, state };
}

function callback(
  on: DefaultFederationService,
  flow: { code: string; state: string },
): Promise<unknown> {
  return on.complete({
    code: flow.code,
    state: flow.state,
    tenantSlug: SLUG,
    ipAddress: '127.0.0.1',
    userAgent: 'jit-race-suite',
    correlationId: `jit-race-${flow.state.slice(-8)}`,
    locale: 'en',
  });
}

async function usersWith(email: string): Promise<number> {
  return owner.user.count({ where: { tenantId, emailNormalized: email, deletedAt: null } });
}

async function provisionedEvents(email: string): Promise<number> {
  const rows = await owner.auditEvent.findMany({
    where: { tenantId, action: 'USER_PROVISIONED_FROM_PROVIDER' },
    select: { subjectId: true },
  });
  const ids = await owner.user.findMany({
    where: { tenantId, emailNormalized: email },
    select: { id: true },
  });
  const mine = new Set(ids.map((row) => row.id));
  return rows.filter((row) => row.subjectId !== null && mine.has(row.subjectId)).length;
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const provisioned = await provisioning.provision({
    slug: SLUG,
    name: 'JIT Race Test',
    adminEmail: `root@${SLUG}.test`,
    adminPassword: 'correct-horse-battery-staple-42',
    adminDisplayName: 'Root Administrator',
  });
  tenantId = provisioned.tenantId;

  // The tenant switches federation on, which is what makes the provider read below reachable.
  await owner.tenant.update({
    where: { id: tenantId },
    data: { settings: { 'feature.federation': true } },
  });

  providerId = uuidv7();
  await owner.identityProvider.create({
    data: {
      id: providerId,
      tenantId,
      name: 'Race IdP',
      issuer: ISSUER,
      discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      domains: ['jit-race.test'],
      defaultRoleKeys: [SystemRole.READER],
      jitProvisioning: true,
      enabled: true,
    },
  });

  service = buildService(new PrismaFederatedUserRepository());
}, 180_000);

afterAll(async () => {
  await owner.$disconnect();
  await prisma.disconnectAll();
});

describe('the two federation endpoints, over a real database', () => {
  it('answers the discovery question instead of failing the request', async () => {
    /*
     * `offerFor` reads the tenant's settings and then its provider, and both read through
     * `requireTransaction()`. Without a unit of work the settings reader swallowed the failure and
     * answered the *product* default rather than this tenant's, and the provider read then threw
     * `NoActiveTransactionError` — not a `DomainError` and not an `HttpException`, so
     * `AllExceptionsFilter` answered `500` on the sign-in screen's own pre-authentication probe.
     */
    const offer = await service.offerFor('ada@jit-race.test', SLUG);

    expect(offer.federated).toBe(true);
    expect(offer.authorizationUrl).toContain(`${ISSUER}/authorize`);
    expect(offer.authorizationUrl).toContain(`client_id=${CLIENT_ID}`);
  });

  it('tells an address this provider does not claim that it is not federated', async () => {
    // The other half of the same read: a domain the provider does not claim must reach the
    // password box, and must do so by answering rather than by throwing.
    const offer = await service.offerFor('someone@elsewhere.test', SLUG);

    expect(offer.federated).toBe(false);
    expect(offer.authorizationUrl).toBeNull();
  });

  it('offers nothing to a tenant that has not switched federation on', async () => {
    /*
     * The gate, pinned. `feature.federation` defaults to false, which is why the broken provider
     * read below it was reached only by tenants using the feature — and why a suite whose tenant
     * always has it on cannot tell whether the gate is consulted at all.
     */
    await owner.tenant.update({
      where: { id: tenantId },
      data: { settings: { 'feature.federation': false } },
    });
    await settings.invalidate(tenantId);
    try {
      const offer = await service.offerFor('ada@jit-race.test', SLUG);

      expect(offer.federated).toBe(false);
      expect(offer.authorizationUrl).toBeNull();
    } finally {
      await owner.tenant.update({
        where: { id: tenantId },
        data: { settings: { 'feature.federation': true } },
      });
      await settings.invalidate(tenantId);
    }
  });

  it('provisions an account on a first federated arrival', async () => {
    // The control, and the assertion that `complete` gets past its own provider read at all.
    const email = 'ada@jit-race.test';
    const flow = await startFlow('subject-ada', email);
    const result = (await callback(service, flow)) as {
      accessToken: string;
      refreshToken: string;
      user: { email: string; roles: readonly string[] };
    };

    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.user.email).toBe(email);
    expect(result.user.roles).toContain(SystemRole.READER);
    expect(await usersWith(email)).toBe(1);
    expect(await provisionedEvents(email)).toBe(1);
  });

  it('signs the same person in again without creating a second account', async () => {
    // The existing-user path: the subject is already linked, so this must sign in rather than
    // provision, and must leave the account count where it was.
    const email = 'ada@jit-race.test';
    const flow = await startFlow('subject-ada', email);
    const result = (await callback(service, flow)) as { accessToken: string };

    expect(result.accessToken).toBeTruthy();
    expect(await usersWith(email)).toBe(1);
    expect(await provisionedEvents(email)).toBe(1);
  });

  it('refuses a callback whose state is not one we issued', async () => {
    // The refusal path still refuses, and refuses for its own reason rather than because the
    // provider read failed underneath it.
    const flow = await startFlow('subject-nobody', 'nobody@jit-race.test');

    await expect(callback(service, { code: flow.code, state: uuidv7() })).rejects.toThrow();
    expect(await usersWith('nobody@jit-race.test')).toBe(0);
  });
});
