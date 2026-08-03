import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { UnauthenticatedError } from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { canSignIn, normalizeEmail } from '../domain/user';
import {
  ACCESS_TOKEN_ISSUER,
  type AccessTokenIssuer,
  type AuthenticatedUser,
  type AuthenticationResult,
  type AuthenticationService,
  PASSWORD_HASHER,
  type PasswordHasher,
  REFRESH_TOKEN_FACTORY,
  type RefreshTokenFactory,
  type SessionContext,
  type SignInCommand,
  TENANT_DIRECTORY,
  type TenantDirectory,
} from './authentication.ports';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepository,
  SESSION_REPOSITORY,
  type SessionRepository,
  type UserCredentialRecord,
} from './ports';

/** Every rejection the caller is told about in the same words. The log records which it was. */
const REJECTED = 'Those credentials were not accepted.';
const SESSION_OVER = 'That session is no longer valid.';

/**
 * Sign-in, refresh and sign-out.
 *
 * Four properties are load-bearing, and each costs something on purpose:
 *
 * **A tenant context is established before any query.** Sign-in is a public route, so no token
 * has built one yet — and every repository read is under row-level security keyed on it. The
 * tenant comes from the host via `TenantDirectory`, which is as far as the host is ever
 * allowed in: what the caller may then *do* is decided by the signed claim in the token this
 * issues, never by where the request arrived.
 *
 * **Failure is uniform.** Unknown tenant, unknown address, wrong password, no password set and
 * disabled account all produce one error.
 *
 * **Failure costs the same time.** When no user is found a verification still runs, against a
 * decoy hash. Otherwise "unknown address" returns in a millisecond and "wrong password" in
 * fifty, and the difference is the directory all over again.
 *
 * **Replay kills the family.** A refresh token that has already been exchanged means someone
 * captured it; since the thief and the legitimate holder are indistinguishable, both are
 * signed out (`docs/architecture/17-security-architecture.md` §2).
 */
@Injectable()
export class DefaultAuthenticationService implements AuthenticationService {
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(TENANT_DIRECTORY) private readonly tenants: TenantDirectory,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(ACCESS_TOKEN_ISSUER) private readonly accessTokens: AccessTokenIssuer,
    @Inject(REFRESH_TOKEN_FACTORY) private readonly refreshTokens: RefreshTokenFactory,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async signIn(command: SignInCommand): Promise<AuthenticationResult> {
    return this.withinTenant(command, REJECTED, async (tenantId) => {
      const credential = await this.credentials.findByEmail(normalizeEmail(command.email));
      const accepted = await this.verifyCredential(credential, command.password);

      if (!accepted || !credential) {
        this.logger.warn('Sign-in rejected', {
          reason: this.rejectionReason(credential),
          correlationId: command.correlationId,
        });
        throw new UnauthenticatedError(REJECTED);
      }

      const now = this.clock.now();

      // Raising the hashing cost later must not lock anyone out, so a credential derived with
      // weaker parameters is upgraded here — the one moment the plaintext is legitimately in
      // hand and already verified.
      if (credential.passwordHash && this.passwords.needsRehash(credential.passwordHash)) {
        await this.credentials.updatePasswordHash(
          credential.id,
          await this.passwords.hash(command.password),
          now,
        );
      }

      await this.credentials.recordSignIn(credential.id, now);

      const familyId = asId<AnyId>(uuidv7(now.getTime()));
      await this.sessions.createFamily({
        id: familyId,
        userId: credential.id,
        ipAddress: command.ipAddress,
        userAgent: command.userAgent,
      });
      return this.mintPair(credential, familyId, tenantId, now);
    });
  }

  async refresh(refreshToken: string, context: SessionContext): Promise<AuthenticationResult> {
    // The transaction below decides the outcome but never throws on the revocation paths.
    // Throwing inside it would roll the revocation back — the exception that reports a stolen
    // token would also erase the record of it, leaving the family live for the next replay.
    const outcome = await this.withinTenant(context, SESSION_OVER, async (tenantId) => {
      const now = this.clock.now();
      const presented = await this.sessions.findByTokenHash(this.refreshTokens.hash(refreshToken));

      if (!presented || presented.familyRevokedAt || presented.expiresAt <= now) {
        return { kind: 'reject' } as const;
      }

      // Replay, or a concurrent exchange that lost the race — indistinguishable, and treated
      // the same. `markUsed` deciding rather than the read above is what makes the race safe.
      if (presented.usedAt || !(await this.sessions.markUsed(presented.id, now))) {
        return {
          kind: 'revoke',
          familyId: presented.familyId,
          reason: 'REFRESH_TOKEN_REUSED',
        } as const;
      }

      const credential = await this.credentials.findById(presented.userId);
      if (!credential || !canSignIn(credential.status)) {
        // Disabled between refreshes: end the session rather than extend it. The token stays
        // consumed, which is why this transaction is allowed to commit.
        return {
          kind: 'revoke',
          familyId: presented.familyId,
          reason: 'USER_NOT_ELIGIBLE',
        } as const;
      }

      return {
        kind: 'issued',
        result: await this.mintPair(credential, presented.familyId, tenantId, now),
      } as const;
    });

    if (outcome.kind === 'issued') {
      return outcome.result;
    }

    if (outcome.kind === 'revoke') {
      // A second, committing transaction. Only now is it safe to fail the request.
      await this.withinTenant(context, SESSION_OVER, async () => {
        await this.sessions.revokeFamily(outcome.familyId, outcome.reason);
      });
      this.logger.warn('Refresh refused; session family revoked', {
        familyId: outcome.familyId,
        reason: outcome.reason,
        correlationId: context.correlationId,
      });
    }

    throw new UnauthenticatedError(SESSION_OVER);
  }

  async signOut(refreshToken: string, context: SessionContext): Promise<void> {
    await this.withinTenant(context, SESSION_OVER, async () => {
      const presented = await this.sessions.findByTokenHash(this.refreshTokens.hash(refreshToken));
      // Unknown or already revoked is success: sign-out is idempotent, and reporting "no such
      // session" would tell an attacker which stolen tokens are still live.
      if (presented && !presented.familyRevokedAt) {
        await this.sessions.revokeFamily(presented.familyId, 'SIGNED_OUT');
      }
    });
  }

  /**
   * Resolves the tenant, establishes the context every repository read needs, and opens the
   * transaction.
   *
   * An unresolvable tenant raises the caller's own failure message rather than "no such
   * tenant": which organisations exist is not a question this endpoint answers.
   */
  private async withinTenant<TResult>(
    context: SessionContext,
    failureMessage: string,
    work: (tenantId: TenantId) => Promise<TResult>,
  ): Promise<TResult> {
    const tenantId = await this.tenants.findIdBySlug(context.tenantSlug);
    if (!tenantId) {
      this.logger.warn('Sign-in against an unknown tenant', {
        correlationId: context.correlationId,
      });
      throw new UnauthenticatedError(failureMessage);
    }

    const requestContext: RequestContext = {
      tenantId,
      // No user yet — that is the whole point of this call. `RequestContext` allows it, and
      // the tenant guard and Prisma extension only ever read `tenantId`.
      userId: null,
      roles: [],
      permissions: [],
      sessionId: null,
      correlationId: context.correlationId,
      permissionVersion: 0,
      locale: context.locale,
    };

    return runWithContext(requestContext, () => this.unitOfWork.run(() => work(tenantId)));
  }

  /** Verifies the presented password, spending the same work whether or not the user exists. */
  private async verifyCredential(
    credential: UserCredentialRecord | null,
    password: string,
  ): Promise<boolean> {
    if (!credential?.passwordHash) {
      await this.passwords.verify(password, this.passwords.decoyHash());
      return false;
    }
    const matches = await this.passwords.verify(password, credential.passwordHash);
    return matches && canSignIn(credential.status);
  }

  private rejectionReason(credential: UserCredentialRecord | null): string {
    if (!credential) {
      return 'NO_SUCH_USER';
    }
    if (!credential.passwordHash) {
      return 'NO_PASSWORD_SET';
    }
    if (!canSignIn(credential.status)) {
      return 'STATUS_NOT_ELIGIBLE';
    }
    return 'BAD_PASSWORD';
  }

  /** Issues the access/refresh pair for a session family that already exists. */
  private async mintPair(
    credential: UserCredentialRecord,
    familyId: AnyId,
    tenantId: TenantId,
    now: Date,
  ): Promise<AuthenticationResult> {
    const refresh = this.refreshTokens.create(now);
    await this.sessions.issueToken({
      id: asId<AnyId>(uuidv7(now.getTime())),
      familyId,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
    });

    const access = this.accessTokens.issue({
      userId: credential.id,
      tenantId,
      roles: credential.roleKeys,
      permissions: credential.permissions,
      sessionId: familyId,
      permissionVersion: credential.permissionVersion,
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
      user: this.toAuthenticatedUser(credential),
    };
  }

  private toAuthenticatedUser(credential: UserCredentialRecord): AuthenticatedUser {
    return {
      id: credential.id,
      email: credential.email,
      displayName: credential.displayName,
      roleIds: credential.roleIds,
      roles: credential.roleKeys,
      permissions: credential.permissions,
      mfaEnrolled: credential.mfaEnrolled,
    };
  }
}
