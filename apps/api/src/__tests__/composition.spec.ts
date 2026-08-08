import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALL_BULK_OPERATION_KINDS, Permission, type UserId, asId } from '@edms/domain';

import { AppModule } from '../app.module';
import { ACL_RESOLVER, type AclResolver } from '../core/authorization';
import { TOKEN_VERIFIER, type TokenVerifier } from '../core/auth';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { TenantDatabase } from '../core/prisma';
import {
  CLOCK_PORT,
  SEARCH_PORT,
  STORAGE_PORT,
  type ClockPort,
  type SearchPort,
  type StoragePort,
} from '../ports';
import { runWithContext, type RequestContext } from '../core/tenancy/tenant-context';
import { RedisCacheAdapter } from '../infrastructure/cache/redis-cache.adapter';
import { JwtTokenService } from '../modules/identity/infrastructure/jwt.token-service';
import {
  DOCUMENT_EXPIRY,
  RETENTION_SERVICE,
  type DocumentExpiry,
  type RetentionService,
} from '../modules/retention/application/ports';
import { BULK_PLAN_REGISTRY, type BulkPlanRegistry } from '../core/bulk/bulk.port';
import { aTenantId } from '../testing/factories';

/**
 * The composition root's own test: does the container resolve, and are the defaults the safe
 * ones?
 *
 * This is the check that catches a port declared but never bound — the failure that otherwise
 * appears as a crash on the first deployment rather than in review. Prisma and Redis are
 * overridden because connecting to them is not what is being tested; every other provider is
 * the real one.
 */
describe('application composition', () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://app:local@localhost:5432/edms';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    // The single-tenant shape, which is what an on-premise installation runs and the cheapest thing
    // to compose against: one placement, derived from this environment, no catalogue to parse.
    process.env.TENANT_ID = '019489f0-0000-7000-8000-00000000000c';
    process.env.TENANT_SLUG = 'composition';
  });

  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  async function compile() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TenantDatabase)
      .useValue({
        clientFor: vi.fn(),
        withTenant: vi.fn(),
        ping: vi.fn(),
        placements: vi.fn(() => Promise.resolve([])),
        disconnectAll: vi.fn(),
      })
      .overrideProvider(RedisCacheAdapter)
      .useValue({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })
      .compile();
    return moduleRef;
  }

  it('resolves every provider the application declares', async () => {
    const moduleRef = await compile();
    expect(moduleRef.get<AppConfig>(APP_CONFIG).app.name).toBe('munaxa-docs-api');
    await moduleRef.close();
  });

  /**
   * The seam Phase 6.1 added, checked where a binding belongs: `documents.expire-effective` is
   * scheduled on the `retention.run` lane, whose single consumer holds `RETENTION_SERVICE` and
   * reaches Document through `DOCUMENT_EXPIRY`. A schedule wired to an unbound port is precisely
   * the "port declared but never bound" failure this file exists to catch — and it is what the
   * whole phase is fixing one layer up, so leaving it unasserted would be the same mistake again.
   */
  it('binds the effective-window sweep the retention lane calls', async () => {
    const moduleRef = await compile();
    const expiry = moduleRef.get<DocumentExpiry>(DOCUMENT_EXPIRY);
    expect(expiry).toBeDefined();
    expect(typeof expiry.expireEffective).toBe('function');

    // And the pass-through the consumer actually calls, so the chain from schedule to use case is
    // whole rather than merely each half existing.
    const retention = moduleRef.get<RetentionService>(RETENTION_SERVICE);
    expect(typeof retention.expireEffectiveDocuments).toBe('function');
  });

  /**
   * Every bulk kind can be rebuilt — Phase 6.2.
   *
   * A queued operation is executed by rebuilding its plan from a registry the owning module fills
   * at `onModuleInit`. A kind with no factory would therefore be accepted, persisted, queued, and
   * then fail at its first delivery — a dead-lettered job rather than a compile error. This is the
   * only place that can ask the question, because it is the only test that composes all five
   * modules, and it is the same class of assertion as "a port declared but never bound".
   */
  it('registers a bulk plan factory for every kind the product can queue', async () => {
    const moduleRef = await compile();
    await moduleRef.init();
    const registry = moduleRef.get<BulkPlanRegistry>(BULK_PLAN_REGISTRY);
    for (const kind of ALL_BULK_OPERATION_KINDS) {
      expect(registry.has(kind), `${kind} has no registered bulk plan factory`).toBe(true);
    }
  });

  it('binds a clock and a storage port, so no use case can name a vendor', async () => {
    const moduleRef = await compile();
    expect(moduleRef.get<ClockPort>(CLOCK_PORT).now()).toBeInstanceOf(Date);
    expect(moduleRef.get<StoragePort>(STORAGE_PORT)).toBeDefined();
    await moduleRef.close();
  });

  it('defaults authorization to deny, not to allow', async () => {
    const moduleRef = await compile();
    const resolver = moduleRef.get<AclResolver>(ACL_RESOLVER);

    // A subject with **no identity at all** — no user, no roles. Phase 14 narrowed the fast path
    // that answers this without touching a database, and narrowing it was the point: a person with
    // no role can now hold reach through an ACL entry naming them personally, so "roles are empty"
    // stopped being sufficient grounds to refuse without looking. What is still sufficient is
    // having nobody to look up, which is what this asserts — and asserting it here, with no
    // database and no request context behind the composition, is what makes it a statement about
    // the *default direction* rather than about a query's result.
    const decision = await resolver.resolve(
      { userId: asId<UserId>(''), roleIds: [], departmentIds: [], delegationIds: [] },
      { type: 'DOCUMENT', id: aTenantId() },
      Permission.DOCUMENT_VIEW,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('CLOSED_BY_DEFAULT');
    await moduleRef.close();
  });

  it('binds the real token verifier now that Identity ships one', async () => {
    const moduleRef = await compile();
    const verifier = moduleRef.get<TokenVerifier>(TOKEN_VERIFIER);

    // Phase 1 replaced NoIssuerTokenVerifier. Asserting the class rather than only that a
    // token is rejected is the point: a garbage string is refused by both, so "it rejected"
    // would keep passing even if the binding silently reverted to the deny-everything default.
    expect(verifier).toBeInstanceOf(JwtTokenService);
    await expect(verifier.verify('anything')).rejects.toThrowError();
    await moduleRef.close();
  });

  it('scopes storage to a tenant before it reaches a provider at all', async () => {
    // The tenant scoping is *outside* the vendor adapter, so a call with no tenant context never
    // reaches one. That ordering is the isolation guarantee: an adapter written in a later phase
    // inherits it and cannot opt out, because nothing above this file can reach past the wrapper
    // (`docs/architecture/adr/0015-database-per-tenant.md`).
    const moduleRef = await compile();
    const storage = moduleRef.get<StoragePort>(STORAGE_PORT);

    await expect(
      storage.createDownloadUrl('any/key', { expiresInSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    await moduleRef.close();
  });

  it('refuses an unconfigured storage provider loudly, naming the variable that fixes it', async () => {
    const moduleRef = await compile();
    const storage = moduleRef.get<StoragePort>(STORAGE_PORT);

    // Inside a context the scoping passes the call through, and the provider underneath is the one
    // that fails — naming the environment variable that would configure it, rather than pretending to
    // have stored bytes it never received.
    await expect(
      runWithContext(
        {
          tenantId: process.env.TENANT_ID as RequestContext['tenantId'],
          userId: null,
          roles: [],
          permissions: [],
          sessionId: null,
          correlationId: 'composition',
          permissionVersion: 0,
          locale: 'en',
        },
        () => storage.createDownloadUrl('any/key', { expiresInSeconds: 60 }),
      ),
    ).rejects.toMatchObject({ details: { configure: 'STORAGE_DRIVER' } });

    await moduleRef.close();
  });

  it('binds search behind its tenant scoping too, so a query cannot name another index', async () => {
    const moduleRef = await compile();
    // Declared in Phase 0.5 and unbound until now: an unbound port is a container that fails to
    // resolve at boot, which reads as a broken deployment rather than an unconfigured one.
    expect(moduleRef.get<SearchPort>(SEARCH_PORT)).toBeDefined();
    await moduleRef.close();
  });
});
