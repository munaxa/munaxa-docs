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
/*
 * A neighbouring tenant in the **same database**, so that what separates the two is row-level
 * security and `uq_user_external_identity`'s tenant column rather than two connection strings.
 * `findByExternalIdentity` carries no `tenantId` predicate — it is scoped by the transaction's
 * `app.tenant_id` — so a suite that put the tenants in separate databases could not tell whether
 * that scoping works at all.
 */
const NEIGHBOUR_SLUG = `jit-race-neighbour-${String(Date.now())}`;
const NEIGHBOUR_TENANT = uuidv7();
const registry = everyTenantRegistry(APP_URL, {
  [SLUG]: PROVISION_TENANT,
  [NEIGHBOUR_SLUG]: NEIGHBOUR_TENANT,
});

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
let neighbourTenantId: TenantId;

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
async function startFlow(
  subject: string,
  email: string,
  forTenant: TenantId = tenantId,
): Promise<{ code: string; state: string }> {
  const state = uuidv7();
  const nonce = uuidv7();
  const code = uuidv7();
  const pending: PendingAuthorization = {
    tenantId: forTenant,
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
  slug: string = SLUG,
): Promise<unknown> {
  return on.complete({
    code: flow.code,
    state: flow.state,
    tenantSlug: slug,
    ipAddress: '127.0.0.1',
    userAgent: 'jit-race-suite',
    correlationId: `jit-race-${flow.state.slice(-8)}`,
    locale: 'en',
  });
}

async function usersWith(email: string, inTenant: TenantId = tenantId): Promise<number> {
  return owner.user.count({
    where: { tenantId: inTenant, emailNormalized: email, deletedAt: null },
  });
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

  const neighbour = await provisioning.provision({
    slug: NEIGHBOUR_SLUG,
    name: 'JIT Race Neighbour',
    adminEmail: `root@${NEIGHBOUR_SLUG}.test`,
    adminPassword: 'correct-horse-battery-staple-42',
    adminDisplayName: 'Root Administrator',
  });
  neighbourTenantId = neighbour.tenantId;
  await owner.tenant.update({
    where: { id: neighbourTenantId },
    data: { settings: { 'feature.federation': true } },
  });
  await owner.identityProvider.create({
    data: {
      id: uuidv7(),
      tenantId: neighbourTenantId,
      name: 'Neighbour IdP',
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

/**
 * Two callers, each parked at the statement that creates the identity.
 *
 * Ordinals are assigned by arrival and the arrival order is fixed rather than observed: the second
 * caller is not started until the first has parked, so the first is always ordinal zero.
 */
class Turnstile<TMarker> {
  readonly arrivals: TMarker[] = [];
  readonly reached: Promise<void>[] = [];
  private readonly announce: (() => void)[] = [];
  private readonly admissions: Promise<void>[] = [];
  private readonly admits: (() => void)[] = [];
  private armed = false;

  arm(callers: number): void {
    for (let index = 0; index < callers; index += 1) {
      let arrive: () => void = () => undefined;
      this.reached.push(
        new Promise<void>((resolve) => {
          arrive = resolve;
        }),
      );
      this.announce.push(arrive);
      let admit: () => void = () => undefined;
      this.admissions.push(
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      );
      this.admits.push(admit);
    }
    this.armed = true;
  }

  async park(marker: TMarker): Promise<void> {
    if (!this.armed) {
      return;
    }
    const ordinal = this.arrivals.length;
    this.arrivals.push(marker);
    this.announce[ordinal]?.();
    await this.admissions[ordinal];
  }

  release(ordinal: number): void {
    this.admits[ordinal]?.();
  }
}

/**
 * One external identity, one account, however many callbacks carry it — Slice 61.
 *
 * `complete` reads whether the external subject already has a local account and, finding none,
 * creates one. Those are two statements in one transaction and two callbacks are two transactions:
 * both read "absent", and then both insert against `uq_user_external_identity`
 * (`tenant_id, identity_provider_id, external_id`).
 *
 * Two distinct authorization flows is what makes this ordinary rather than exotic. The state is
 * single-use, so a *replayed* callback is refused long before here — but somebody signing in for
 * the first time from two tabs has two states and two valid assertions for one subject, and an
 * identity provider that retries its redirect produces the same shape.
 */
describe('one external identity, one account, however many callbacks carry it', () => {
  const turnstile = new Turnstile<string>();

  /**
   * The real repository, subclassed: the override only adds a place to stand before the insert.
   *
   * A caller reaches `provision` only after `findByExternalIdentity` has answered "absent", so two
   * parked callers holding one subject is proof that both read an empty result — and not that one
   * of them never looked.
   */
  class ParkingFederatedUserRepository extends PrismaFederatedUserRepository {
    override async provision(
      input: Parameters<PrismaFederatedUserRepository['provision']>[0],
    ): Promise<boolean> {
      await turnstile.park(input.externalId);
      return super.provision(input);
    }
  }

  let parking: DefaultFederationService;

  beforeAll(() => {
    parking = buildService(new ParkingFederatedUserRepository());
  });

  async function identitiesFor(subject: string): Promise<number> {
    return owner.user.count({
      where: { tenantId, identityProviderId: providerId, externalId: subject },
    });
  }

  async function roleRowsFor(email: string): Promise<number> {
    return owner.userRole.count({ where: { user: { tenantId, emailNormalized: email } } });
  }

  it('provisions two different subjects independently', async () => {
    // A control, and the one that says the parked path provisions correctly when nothing contends.
    const first = await startFlow('subject-hopper', 'hopper@jit-race.test');
    const second = await startFlow('subject-lamport', 'lamport@jit-race.test');

    await callback(parking, first);
    await callback(parking, second);

    expect(await usersWith('hopper@jit-race.test')).toBe(1);
    expect(await usersWith('lamport@jit-race.test')).toBe(1);
    expect(await identitiesFor('subject-hopper')).toBe(1);
    expect(await identitiesFor('subject-lamport')).toBe(1);
  });

  it('signs both callers in when two callbacks carry one new identity at the same moment', async () => {
    const email = 'grace@jit-race.test';
    const first = await startFlow('subject-grace', email);
    const second = await startFlow('subject-grace', email);
    expect(await usersWith(email)).toBe(0);
    turnstile.arm(2);

    // Each from its own scope, so each opens its own transaction.
    const one = callback(parking, first);
    await turnstile.reached[0];
    const two = callback(parking, second);
    await turnstile.reached[1];

    // Both read the identity as absent, and both are about to create it.
    expect(turnstile.arrivals).toEqual(['subject-grace', 'subject-grace']);

    turnstile.release(0);
    const winner = await one.then(
      (value) => ({ kind: 'signed-in' as const, value }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );
    turnstile.release(1);
    const loser = await two.then(
      (value) => ({ kind: 'signed-in' as const, value }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    // The data is safe either way — the constraint sees to that. One account, one identity, one
    // set of roles, one provisioning event.
    expect(await usersWith(email)).toBe(1);
    expect(await identitiesFor('subject-grace')).toBe(1);
    expect(await provisionedEvents(email)).toBe(1);
    expect(await roleRowsFor(email)).toBe(1);

    // What is not safe is the answer. A sequential second arrival signs in, so a concurrent one
    // that is refused is being told something the same request would not be told a moment later.
    expect(winner.kind).toBe('signed-in');
    expect(loser.kind).toBe('signed-in');
  });

  it('refuses a subject whose address is already held by a different subject', async () => {
    /*
     * The other reason the insert can be refused, and the reason the loser's resolution has to be
     * able to come back empty.
     *
     * `uq_user_tenant_email` is the constraint here rather than the identity one, and no race is
     * involved: this address belongs to an account bound to *another* subject at this provider.
     * `findByExternalIdentity` will not return it — its address branch matches only accounts bound
     * to nobody — so there is no winner to converge on, and the only safe answer is to refuse.
     *
     * Signing this caller into the account that holds the address would be an account takeover
     * performed by whoever can make the provider assert an address, which is why this is asserted
     * rather than assumed. The sequential path met the same conflict as a raw constraint violation.
     */
    const taken = 'katherine@jit-race.test';
    const held = await startFlow('subject-katherine', taken);
    await callback(service, held);
    const owner1 = await owner.user.findFirstOrThrow({
      where: { tenantId, emailNormalized: taken },
      select: { id: true },
    });

    const impostor = await startFlow('subject-someone-else', taken);
    const outcome = await callback(service, impostor).then(
      (value) => ({ kind: 'signed-in' as const, value }),
      () => ({ kind: 'refused' as const }),
    );

    expect(outcome.kind).toBe('refused');
    // And nothing was taken over, nor a second account created.
    expect(await usersWith(taken)).toBe(1);
    const still = await owner.user.findFirstOrThrow({
      where: { tenantId, emailNormalized: taken },
      select: { id: true, externalId: true },
    });
    expect(still.id).toBe(owner1.id);
    expect(still.externalId).toBe('subject-katherine');
  });

  it('gives a neighbouring tenant asserting the same subject its own account', async () => {
    /*
     * The convergence must not reach across the tenant boundary. Both tenants live in one database
     * here, so what keeps them apart is `app.tenant_id` on the transaction and the tenant column in
     * `uq_user_external_identity` — not a separate connection string. A resolution that dropped the
     * tenant scope would hand this callback the *other* tenant's account and sign somebody into an
     * organisation they have no membership of.
     */
    const email = 'grace@jit-race.test';
    const mine = await usersWith(email);
    expect(mine).toBe(1);

    const flow = await startFlow('subject-grace', email, neighbourTenantId);
    const result = (await callback(service, flow, NEIGHBOUR_SLUG)) as {
      accessToken: string;
      user: { id: string };
    };

    expect(result.accessToken).toBeTruthy();
    // Its own account, in its own tenant, and the neighbour's count is untouched.
    expect(await usersWith(email, neighbourTenantId)).toBe(1);
    expect(await usersWith(email)).toBe(1);

    const ours = await owner.user.findFirstOrThrow({
      where: { tenantId, emailNormalized: email },
      select: { id: true },
    });
    expect(result.user.id).not.toBe(ours.id);
  });
});
