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

import type { Logger } from '../../../core/observability/logger';
import type { UnitOfWork } from '../../../core/prisma/unit-of-work';
import { FakeClock } from '../../../testing/fake-ports';
import type {
  AccessTokenIssuer,
  AccessTokenRequest,
  PasswordHasher,
  RefreshTokenFactory,
  SessionContext,
  TenantDirectory,
} from './authentication.ports';
import { DefaultAuthenticationService } from './authentication.service';
import type {
  CredentialRepository,
  RefreshTokenRecord,
  SessionRepository,
  UserCredentialRecord,
} from './ports';

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
  let sessions: SessionRepository;
  let tenants: TenantDirectory;
  let passwords: PasswordHasher;
  let issuer: AccessTokenIssuer;
  let refreshTokens: RefreshTokenFactory;
  let clock: FakeClock;
  let service: DefaultAuthenticationService;
  let revoked: { familyId: AnyId; reason: string }[];
  let issuedFor: AccessTokenRequest[];

  beforeEach(() => {
    revoked = [];
    issuedFor = [];
    clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));

    credentials = {
      findByEmail: vi.fn().mockResolvedValue(aCredential()),
      findById: vi.fn().mockResolvedValue(aCredential()),
      updatePasswordHash: vi.fn().mockResolvedValue(undefined),
      recordSignIn: vi.fn().mockResolvedValue(undefined),
    };

    sessions = {
      createFamily: vi.fn().mockResolvedValue(undefined),
      issueToken: vi.fn().mockResolvedValue(undefined),
      findByTokenHash: vi.fn().mockResolvedValue(null),
      markUsed: vi.fn().mockResolvedValue(true),
      revokeFamily: vi.fn((familyId: AnyId, reason: string) => {
        revoked.push({ familyId, reason });
        return Promise.resolve();
      }),
      revokeAllForUser: vi.fn().mockResolvedValue(undefined),
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

    refreshTokens = {
      create: vi.fn().mockReturnValue({
        token: 'refresh-plain',
        hash: 'refresh-hash',
        expiresAt: new Date('2026-02-01T00:00:00Z'),
      }),
      hash: vi.fn((token: string) => `hashed:${token}`),
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
        const committed = revoked.length;
        try {
          return await work();
        } catch (error) {
          revoked.length = committed;
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

    service = new DefaultAuthenticationService(
      credentials,
      sessions,
      tenants,
      passwords,
      issuer,
      refreshTokens,
      clock,
      unitOfWork,
      logger,
    );
  });

  describe('signIn', () => {
    it('issues a pair and opens a session family', async () => {
      const result = await service.signIn({ ...context, email: 'ada@acme.test', password: 'pw' });

      expect(result.accessToken).toBe('access-token');
      expect(result.refreshToken).toBe('refresh-plain');
      expect(sessions.createFamily).toHaveBeenCalledOnce();
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
      expect(sessions.createFamily).not.toHaveBeenCalled();
    });

    it('upgrades a password hash derived with weaker parameters', async () => {
      vi.mocked(passwords.needsRehash).mockReturnValue(true);

      await service.signIn({ ...context, email: 'ada@acme.test', password: 'pw' });

      expect(credentials.updatePasswordHash).toHaveBeenCalledWith(USER, 'new-hash', clock.now());
    });
  });

  describe('refresh', () => {
    function present(overrides: Partial<RefreshTokenRecord> = {}): void {
      vi.mocked(sessions.findByTokenHash).mockResolvedValue({
        id: asId<AnyId>('01900000-0000-7000-8000-0000000000t1'.replace('t', 'a')),
        familyId: FAMILY,
        userId: USER,
        expiresAt: new Date('2026-02-01T00:00:00Z'),
        usedAt: null,
        familyRevokedAt: null,
        ...overrides,
      });
    }

    it('rotates the token, keeping the same family', async () => {
      present();

      const result = await service.refresh('refresh-plain', context);

      expect(result.refreshToken).toBe('refresh-plain');
      expect(sessions.markUsed).toHaveBeenCalledOnce();
      expect(sessions.createFamily).not.toHaveBeenCalled();
      expect(revoked).toEqual([]);
    });

    it('revokes the whole family when a token is presented twice', async () => {
      present({ usedAt: new Date('2026-01-01T00:00:00Z') });

      await expect(service.refresh('refresh-plain', context)).rejects.toThrowError();

      expect(revoked).toEqual([{ familyId: FAMILY, reason: 'REFRESH_TOKEN_REUSED' }]);
    });

    it('treats losing the claim race as reuse', async () => {
      present();
      // Another request marked it used first: this call must not issue a second live pair.
      vi.mocked(sessions.markUsed).mockResolvedValue(false);

      await expect(service.refresh('refresh-plain', context)).rejects.toThrowError();

      expect(revoked).toEqual([{ familyId: FAMILY, reason: 'REFRESH_TOKEN_REUSED' }]);
    });

    it('refuses a token whose family is already revoked', async () => {
      present({ familyRevokedAt: new Date('2026-01-01T00:00:00Z') });

      await expect(service.refresh('refresh-plain', context)).rejects.toThrowError();
      expect(sessions.markUsed).not.toHaveBeenCalled();
    });

    it('refuses an expired token', async () => {
      present({ expiresAt: new Date('2025-12-31T00:00:00Z') });

      await expect(service.refresh('refresh-plain', context)).rejects.toThrowError();
    });

    it('ends the session when the user was disabled since the last refresh', async () => {
      present();
      vi.mocked(credentials.findById).mockResolvedValue(aCredential({ status: 'DISABLED' }));

      await expect(service.refresh('refresh-plain', context)).rejects.toThrowError();

      expect(revoked).toEqual([{ familyId: FAMILY, reason: 'USER_NOT_ELIGIBLE' }]);
    });
  });

  describe('signOut', () => {
    it('revokes the family behind the presented token', async () => {
      vi.mocked(sessions.findByTokenHash).mockResolvedValue({
        id: asId<AnyId>('01900000-0000-7000-8000-0000000000a1'),
        familyId: FAMILY,
        userId: USER,
        expiresAt: new Date('2026-02-01T00:00:00Z'),
        usedAt: null,
        familyRevokedAt: null,
      });

      await service.signOut('refresh-plain', context);

      expect(revoked).toEqual([{ familyId: FAMILY, reason: 'SIGNED_OUT' }]);
    });

    it('succeeds for an unknown token rather than reporting that it is unknown', async () => {
      vi.mocked(sessions.findByTokenHash).mockResolvedValue(null);

      await expect(service.signOut('whatever', context)).resolves.toBeUndefined();
      expect(revoked).toEqual([]);
    });
  });
});
