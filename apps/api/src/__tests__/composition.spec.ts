import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Permission } from '@edms/domain';

import { AppModule } from '../app.module';
import { ACL_RESOLVER, type AclResolver } from '../core/authorization';
import { TOKEN_VERIFIER, type TokenVerifier } from '../core/auth';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { TenantDatabase } from '../core/prisma';
import { CLOCK_PORT, STORAGE_PORT, type ClockPort, type StoragePort } from '../ports';
import { RedisCacheAdapter } from '../infrastructure/cache/redis-cache.adapter';
import { JwtTokenService } from '../modules/identity/infrastructure/jwt.token-service';
import { aTenantId, aUserId } from '../testing/factories';

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

  it('binds a clock and a storage port, so no use case can name a vendor', async () => {
    const moduleRef = await compile();
    expect(moduleRef.get<ClockPort>(CLOCK_PORT).now()).toBeInstanceOf(Date);
    expect(moduleRef.get<StoragePort>(STORAGE_PORT)).toBeDefined();
    await moduleRef.close();
  });

  it('defaults authorization to deny, not to allow', async () => {
    const moduleRef = await compile();
    const resolver = moduleRef.get<AclResolver>(ACL_RESOLVER);

    const decision = await resolver.resolve(
      { userId: aUserId(), roleIds: [], departmentIds: [], delegationIds: [] },
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

  it('refuses an unconfigured storage provider loudly, naming the variable that fixes it', async () => {
    const moduleRef = await compile();
    const storage = moduleRef.get<StoragePort>(STORAGE_PORT);
    await expect(
      storage.createDownloadUrl('any/key', { expiresInSeconds: 60 }),
    ).rejects.toMatchObject({ details: { configure: 'STORAGE_DRIVER' } });
    await moduleRef.close();
  });
});
