import 'reflect-metadata';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AnyId,
  type RoleId,
  type TenantId,
  type UserId,
  Permission,
  asId,
} from '@edms/domain';

import type { AuditActor, AuditEntry, AuditWriter } from '../../../core/audit/audit-writer.port';
import type { Logger } from '../../../core/observability/logger';
import type { UnitOfWork } from '../../../core/prisma/unit-of-work';
import { FakeClock } from '../../../testing/fake-ports';
import type {
  AccessTokenIssuer,
  AccessTokenRequest,
  PasswordHasher,
  SessionContext,
  TenantDirectory,
} from './authentication.ports';
import type { MfaService } from './mfa.ports';
import { DefaultAuthenticationService } from './authentication.service';
import {
  MemoryRefreshFamilyStore,
  SessionManager,
  sessionStoreOverFamilies,
} from '@munaxa/session';
import { MemoryRefreshTokenStore, RefreshTokenService } from '@munaxa/auth';
import { unsafeId } from '@munaxa/types';
import type {
  SessionId as PlatformSessionId,
  TenantId as PlatformTenantId,
  TokenFamilyId as PlatformFamilyId,
  UserId as PlatformUserId,
} from '@munaxa/types';
import type { CredentialRepository, UserCredentialRecord } from './ports';

/**
 * The properties these tests hold onto are the ones an attacker probes:
 *
 * - every rejection says the same thing, whatever the real reason;
 * - a refresh token works exactly once, and a second use ends the whole session family;
 * - a user disabled mid-session cannot refresh their way past it.
 */

const TENANT = asId<TenantId>('01900000-0000-7000-8000-00000000000a');
const USER = asId<UserId>('01900000-0000-7000-8000-000000000001');
const FAMILY = asId<AnyId>('01900000-0000-7000-8000-0000000000f1');

const context: SessionContext = {
  tenantSlug: 'acme',
  ipAddress: '198.51.100.7',
  userAgent: 'vitest',
  correlationId: 'corr-1',
  locale: 'en',
};

function aCredential(overrides: Partial<UserCredentialRecord> = {}): UserCredentialRecord {
  return {
    id: USER,
    email: 'ada@acme.test',
    displayName: 'Ada',
    status: 'ACTIVE',
    passwordHash: 'stored-hash',
    mfaEnrolled: false,
    permissionVersion: 1,
    roleIds: [asId<RoleId>('01900000-0000-7000-8000-000000000r01'.replace('r', 'a'))],
    roleKeys: ['TENANT_ADMIN'],
    permissions: [Permission.USER_MANAGE],
    ...overrides,
  };
}

describe('DefaultAuthenticationService', () => {
  let credentials: CredentialRepository;
  let refreshTokens: RefreshTokenService;
  let tokenStore: MemoryRefreshTokenStore;
  // The platform's own manager over its own memory store, rather than a mock. A mock would assert
  // that this service calls the right methods; this asserts that the resulting session is the one
  // the platform would have produced — deadlines, limit enforcement and all.
  let sessionManager: SessionManager;
  let familyStore: MemoryRefreshFamilyStore;
  let tenants: TenantDirectory;
  let passwords: PasswordHasher;
  let issuer: AccessTokenIssuer;
  let clock: FakeClock;
  let service: DefaultAuthenticationService;
  let revoked: { familyId: AnyId; reason: string }[];
  let issuedFor: AccessTokenRequest[];
  let audited: { action: string; outcome: string }[];
  let audit: AuditWriter;

  beforeEach(() => {
    revoked = [];
    issuedFor = [];
    audited = [];
    clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));

    credentials = {
      findByEmail: vi.fn().mockResolvedValue(aCredential()),
      findById: vi.fn().mockResolvedValue(aCredential()),
      updatePasswordHash: vi.fn().mockResolvedValue(undefined),
      recordSignIn: vi.fn().mockResolvedValue(undefined),
    };

    tenants = { findIdBySlug: vi.fn().mockResolvedValue(TENANT) };

    passwords = {
      hash: vi.fn().mockResolvedValue('new-hash'),
      verify: vi.fn().mockResolvedValue(true),
      needsRehash: vi.fn().mockReturnValue(false),
      decoyHash: vi.fn().mockReturnValue('decoy'),
    };

    issuer = {
      issue: vi.fn((request: AccessTokenRequest) => {
        issuedFor.push(request);
        return { token: 'access-token', expiresAt: new Date('2026-01-01T00:15:00Z') };
      }),
    };

    // Audit entries are recorded through the same rollback-aware boundary as revocations, so a
    // trail written inside a transaction that then throws is discarded here too.
    audit = {
      write: (_actor: AuditActor, entry: AuditEntry) => {
        audited.push({ action: entry.action, outcome: entry.outcome });
        return Promise.resolve();
      },
      writeStandalone: (_actor: AuditActor, entry: AuditEntry) => {
        audited.push({ action: entry.action, outcome: entry.outcome });
        return Promise.resolve();
      },
    };

    // A unit of work that actually models rollback.
    //
    // A double that simply calls the work would pass while the real database threw the writes
    // away: revoking a session family and then throwing inside the same transaction rolls the
    // revocation back, so the exception reporting a stolen token also erases the record of it.
    // That bug shipped past a suite whose double ignored transactions, and was caught only
    // against PostgreSQL. Modelling commit and rollback here is what keeps it caught.
    const unitOfWork: UnitOfWork = {
      run: async (work) => {
        const committedRevocations = revoked.length;
        const committedAudit = audited.length;
        try {
          return await work();
        } catch (error) {
          revoked.length = committedRevocations;
          audited.length = committedAudit;
          throw error;
        }
      },
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    /**
     * The second factor, stubbed to "nobody is enrolled".
     *
     * The real one is `DefaultMfaService` and it has its own suite. What this file is about is the
     * password path, and an enrolment-free stub is the honest shape for it: every assertion below is
     * about an account with one factor, which is what almost every account has.
     */
    const noMfa = {
      statusFor: () =>
        Promise.resolve({ enrolled: false, pending: false, recoveryCodesRemaining: 0 }),
      begin: () => Promise.reject(new Error('not used')),
      confirm: () => Promise.reject(new Error('not used')),
      challenge: () => Promise.resolve(true),
      isRequired: () => Promise.resolve(false),
      remove: () => Promise.resolve(),
    } as unknown as MfaService;
    tokenStore = new MemoryRefreshTokenStore();
    refreshTokens = new RefreshTokenService({
      store: tokenStore,
      clock: { now: () => clock.now().getTime() },
    });
    familyStore = new MemoryRefreshFamilyStore();
    sessionManager = new SessionManager({
      store: sessionStoreOverFamilies(familyStore),
      clock: { now: () => clock.now().getTime() },
      generateId: () => unsafeId<PlatformSessionId>(FAMILY),
      // Revocations are observed through the platform's own event surface rather than by spying on
      // a repository method, because the repository no longer decides them.
      onEvent: (event) => {
        if (event.name === 'session.revoked' && event.reason) {
          revoked.push({ familyId: asId<AnyId>(event.session.id), reason: event.reason });
        }
      },
    });
    service = new DefaultAuthenticationService(
      credentials,
      sessionManager,
      tenants,
      passwords,
      issuer,
      refreshTokens,
      clock,
      unitOfWork,
      audit,
      logger,
      noMfa,
    );
  });

  describe('signIn', () => {
    it('issues a pair and opens a session family', async () => {
      const result = await service.signIn({ ...context, email: 'ada@acme.test', password: 'pw' });

      expect(result.accessToken).toBe('access-token');
      // The plaintext is CSPRNG output and appears exactly once, here — so the assertion is that
      // it resolves to a stored token in the family just opened, not that it equals a fixture.
      const stored = await refreshTokens.inspect(
        unsafeId<PlatformTenantId>(TENANT),
        result.refreshToken,
      );
      expect(stored?.familyId).toBe(FAMILY);
      // Docs' permissionVersion, carried through as the platform's tokenVersion.
      expect(stored?.tokenVersion).toBe(1);
      expect(familyStore.size).toBe(1);
      // The tenant in the token comes from the directory, never from the caller.
      expect(issuedFor[0]?.tenantId).toBe(TENANT);
    });

    it('fails identically whether the address is unknown or the password is wrong', async () => {
      vi.mocked(passwords.verify).mockResolvedValue(false);
      const wrongPassword = await service
        .signIn({ ...context, email: 'ada@acme.test', password: 'nope' })
        .catch((error: Error) => error.message);

      vi.mocked(credentials.findByEmail).mockResolvedValue(null);
      const unknownUser = await service
        .signIn({ ...context, email: 'nobody@acme.test', password: 'pw' })
        .catch((error: Error) => error.message);

      vi.mocked(passwords.verify).mockResolvedValue(true);
      vi.mocked(tenants.findIdBySlug).mockResolvedValue(null);
      const unknownTenant = await service
        .signIn({ ...context, email: 'ada@acme.test', password: 'pw' })
        .catch((error: Error) => error.message);

      expect(wrongPassword).toBe(unknownUser);
      expect(unknownUser).toBe(unknownTenant);
    });

    it('still spends a verification when no user exists, so timing does not answer the question', async () => {
      vi.mocked(credentials.findByEmail).mockResolvedValue(null);

      await service
        .signIn({ ...context, email: 'ghost@acme.test', password: 'pw' })
        .catch(() => {});

      expect(passwords.verify).toHaveBeenCalledWith('pw', 'decoy');
    });

    it('refuses a disabled user who presents the correct password', async () => {
      vi.mocked(credentials.findByEmail).mockResolvedValue(aCredential({ status: 'DISABLED' }));

      await expect(
        service.signIn({ ...context, email: 'ada@acme.test', password: 'pw' }),
      ).rejects.toThrowError();
      expect(familyStore.size).toBe(0);
    });

    it('upgrades a password hash derived with weaker parameters', async () => {
      vi.mocked(passwords.needsRehash).mockReturnValue(true);

      await service.signIn({ ...context, email: 'ada@acme.test', password: 'pw' });

      expect(credentials.updatePasswordHash).toHaveBeenCalledWith(USER, 'new-hash', clock.now());
    });
  });

  /**
   * Open the family the presented token belongs to.
   *
   * Refresh now consults the session, not just the token: the lineage carries the deadlines that
   * bound it, so a token whose family does not exist is a token with nothing to extend. These
   * tests exercise rotation, so the family has to be there — which is what sign-in does in
   * production.
   */
  async function openFamily(): Promise<void> {
    await sessionManager.create({
      tenantId: unsafeId<PlatformTenantId>(TENANT),
      userId: unsafeId<PlatformUserId>(USER),
      authMethods: ['password'],
      mfaSatisfied: false,
      tokenVersion: 0,
    });
  }

  /**
   * Issue a real refresh token into the memory store, in the family `openFamily` opened.
   *
   * Real rather than mocked: rotation, replay detection and the compare-and-swap that decides
   * between them are the platform's now, and a mocked store would assert only that this service
   * calls it. Presenting an actual token exercises the mechanism.
   */
  async function issueToken(): Promise<string> {
    const issued = await refreshTokens.issue({
      tenantId: unsafeId<PlatformTenantId>(TENANT),
      userId: unsafeId<PlatformUserId>(USER),
      tokenVersion: 0,
      familyId: unsafeId<PlatformFamilyId>(FAMILY),
      sessionId: unsafeId<PlatformSessionId>(FAMILY),
    });
    return issued.token;
  }

  describe('refresh', () => {
    it('rotates the token, keeping the same family', async () => {
      await openFamily();
      const token = await issueToken();

      const result = await service.refresh(token, context);

      // A new token, not the one presented — the whole point of rotation.
      expect(result.refreshToken).not.toBe(token);
      expect(familyStore.size).toBe(1);
      expect(revoked).toEqual([]);

      // …and the replacement belongs to the same lineage.
      const rotated = await refreshTokens.inspect(
        unsafeId<PlatformTenantId>(TENANT),
        result.refreshToken,
      );
      expect(rotated?.familyId).toBe(FAMILY);
    });

    it('revokes the whole family when a token is presented twice', async () => {
      await openFamily();
      const token = await issueToken();
      await service.refresh(token, context);

      // The same token again. It was consumed by the rotation above.
      await expect(service.refresh(token, context)).rejects.toThrowError();

      expect(revoked).toEqual([{ familyId: FAMILY, reason: 'token-reuse' }]);
    });

    it('treats losing the claim race as reuse', async () => {
      // Two exchanges of one token, issued together. Exactly one may win the compare-and-swap,
      // and the loser is indistinguishable from a thief — which is the correct reading.
      await openFamily();
      const token = await issueToken();

      const results = await Promise.allSettled([
        service.refresh(token, context),
        service.refresh(token, context),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(revoked).toEqual([{ familyId: FAMILY, reason: 'token-reuse' }]);
    });

    it('refuses a token whose family is already revoked', async () => {
      // No family opened, so the session the token names does not exist.
      const token = await issueToken();

      await expect(service.refresh(token, context)).rejects.toThrowError();
    });

    it('refuses a token this tenant did not issue', async () => {
      await openFamily();

      await expect(service.refresh('not-a-token-we-minted', context)).rejects.toThrowError();
      expect(revoked).toEqual([]);
    });

    it('ends the session when the user was disabled since the last refresh', async () => {
      await openFamily();
      const token = await issueToken();
      vi.mocked(credentials.findById).mockResolvedValue(aCredential({ status: 'DISABLED' }));

      await expect(service.refresh(token, context)).rejects.toThrowError();

      expect(revoked).toEqual([{ familyId: FAMILY, reason: 'account-disabled' }]);
    });
  });

  describe('audit', () => {
    it('records a successful sign-in', async () => {
      await service.signIn({ ...context, email: 'ada@acme.test', password: 'pw' });

      expect(audited).toEqual([{ action: 'LOGIN_SUCCEEDED', outcome: 'SUCCESS' }]);
    });

    it('records a failed sign-in, and the record survives the rejection', async () => {
      vi.mocked(passwords.verify).mockResolvedValue(false);

      await expect(
        service.signIn({ ...context, email: 'ada@acme.test', password: 'nope' }),
      ).rejects.toThrowError();

      // The whole point: the request failed, and the attempt is still on the record. Written
      // inside the transaction that then threw, this array would be empty.
      expect(audited).toEqual([{ action: 'LOGIN_FAILED', outcome: 'DENIED' }]);
    });

    it('records an attempt against an address that does not exist', async () => {
      vi.mocked(credentials.findByEmail).mockResolvedValue(null);

      await expect(
        service.signIn({ ...context, email: 'ghost@acme.test', password: 'pw' }),
      ).rejects.toThrowError();

      expect(audited).toEqual([{ action: 'LOGIN_FAILED', outcome: 'DENIED' }]);
    });

    it('records the revocation when a refresh token is replayed', async () => {
      await openFamily();
      const token = await issueToken();
      await service.refresh(token, context);
      audited.length = 0;

      await expect(service.refresh(token, context)).rejects.toThrowError();

      expect(audited).toEqual([{ action: 'SESSION_REVOKED', outcome: 'DENIED' }]);
    });

    it('records a sign-out', async () => {
      const token = await issueToken();

      await service.signOut(token, context);

      expect(audited).toEqual([{ action: 'SESSION_REVOKED', outcome: 'SUCCESS' }]);
    });
  });

  describe('signOut', () => {
    it('revokes the family behind the presented token', async () => {
      await openFamily();
      const token = await issueToken();

      await service.signOut(token, context);

      expect(revoked).toEqual([{ familyId: FAMILY, reason: 'logout' }]);
    });

    it('succeeds for an unknown token rather than reporting that it is unknown', async () => {
      // Nothing was ever issued, so the store genuinely does not know this token.
      await expect(service.signOut('whatever', context)).resolves.toBeUndefined();
      expect(revoked).toEqual([]);
    });
  });
});
