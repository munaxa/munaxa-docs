import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type TenantId,
  type UserId,
  AuditOutcome,
  AuditSubjectType,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import {
  AUDIT_WRITER,
  type AuditActor,
  type AuditWriter,
} from '../../../core/audit/audit-writer.port';
import { MfaRequiredError, UnauthenticatedError } from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { SecurityAudit } from '../domain/audit-actions';
import { canSignIn, normalizeEmail } from '../domain/user';
import {
  ACCESS_TOKEN_ISSUER,
  type AccessTokenIssuer,
  type AuthenticatedUser,
  type AuthenticationResult,
  type AuthenticationService,
  PASSWORD_HASHER,
  type PasswordHasher,
  type SessionContext,
  type SignInCommand,
  TENANT_DIRECTORY,
  type TenantDirectory,
} from './authentication.ports';
import { MFA_SERVICE, type MfaService } from './mfa.ports';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepository,
  type UserCredentialRecord,
} from './ports';
import {
  REFRESH_TOKEN_SERVICE,
  type PlatformRefreshTokenService,
} from '../infrastructure/refresh-token-service.provider';
import {
  SESSION_MANAGER,
  type PlatformSessionManager,
} from '../infrastructure/session-manager.provider';
import { unsafeId } from '@munaxa/types';
import type {
  SessionId as PlatformSessionId,
  TenantId as PlatformTenantId,
  TokenFamilyId as PlatformFamilyId,
  UserId as PlatformUserId,
} from '@munaxa/types';
import type { IssuedRefreshToken } from '@munaxa/auth';
import { isPlatformError } from '@munaxa/types';

/**
 * `@edms/domain` and `@munaxa/types` both brand their ids, structurally identically and nominally
 * distinct, so a value crosses between them by re-branding rather than by conversion. Named
 * functions rather than inline casts so the boundary is greppable — and so the day the two
 * vocabularies are reconciled (P4.2 §4) there is one place to change.
 */
const platformTenant = (id: TenantId): PlatformTenantId => unsafeId<PlatformTenantId>(id);
const platformUser = (id: UserId): PlatformUserId => unsafeId<PlatformUserId>(id);
const platformSession = (id: AnyId): PlatformSessionId => unsafeId<PlatformSessionId>(id);

/** Narrow a thrown value to one of the platform's closed error codes. */
function isPlatformCode(error: unknown, code: string): boolean {
  return isPlatformError(error) && error.code === code;
}

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
    @Inject(SESSION_MANAGER) private readonly sessionManager: PlatformSessionManager,
    @Inject(TENANT_DIRECTORY) private readonly tenants: TenantDirectory,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(ACCESS_TOKEN_ISSUER) private readonly accessTokens: AccessTokenIssuer,
    @Inject(REFRESH_TOKEN_SERVICE) private readonly refreshTokens: PlatformRefreshTokenService,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(MFA_SERVICE) private readonly mfa: MfaService,
  ) {}

  async signIn(command: SignInCommand): Promise<AuthenticationResult> {
    // As in `refresh`, the transaction below decides but does not throw. A failed sign-in is
    // exactly the event an attacker would prefer to leave no trace of, and throwing here would
    // roll its audit record back along with everything else.
    const outcome = await this.withinTenant(command, REJECTED, async (tenantId) => {
      const credential = await this.credentials.findByEmail(normalizeEmail(command.email));
      const accepted = await this.verifyCredential(credential, command.password);

      if (!accepted || !credential) {
        return { kind: 'rejected', reason: this.rejectionReason(credential) } as const;
      }

      // **The second factor, between the password and the session.** Phase 14's addition, and the
      // order is the whole of it: the challenge is only asked after the password is verified, so
      // "does this address have MFA" is not a question an unauthenticated caller can ask, and no
      // session exists until both factors are satisfied.
      //
      // A missing code and a wrong one are told apart, which is deliberate and is not a leak: at
      // this point the caller has already proved the password, so "a code is required" tells them
      // nothing they could not learn by holding the account. Collapsing the two would mean a client
      // could not distinguish "prompt for a code" from "that code was wrong" — and would prompt
      // with an unexplained failure.
      // Recorded on the session so a later step-up check can ask "was a second factor used to
      // open this?" without re-deriving it from enrolment, which can change underneath a session.
      let mfaSatisfied = false;
      if (await this.mfa.isRequired(credential.id)) {
        if (command.mfaCode === undefined || command.mfaCode === '') {
          return { kind: 'mfa-required' } as const;
        }
        if (!(await this.mfa.challenge(credential.id, command.mfaCode))) {
          // `MFA_FAILED` is already in the trail — the challenge writes it. This path returns a
          // rejection so the outer handler writes `LOGIN_FAILED` beside it: the account holder
          // failed to sign in *and* failed a factor, and an investigation asks both questions.
          return { kind: 'rejected', reason: 'BAD_MFA_CODE' } as const;
        }
        mfaSatisfied = true;
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

      // The platform opens the session. It mints the id, writes both deadlines, records how the
      // user authenticated, and enforces the concurrency limit inside this transaction — none of
      // which the local `createFamily` did, which is why a lineage used to live forever.
      const session = await this.sessionManager.create({
        tenantId: platformTenant(tenantId),
        userId: platformUser(credential.id),
        authMethods: mfaSatisfied ? ['password', 'totp'] : ['password'],
        mfaSatisfied,
        // Docs' `permissionVersion` is what the platform calls `tokenVersion`: bumped when a
        // credential's authority changes, and carried in the access token so every session
        // issued before the bump stops being honoured.
        tokenVersion: credential.permissionVersion,
        ...(command.ipAddress === null ? {} : { ipAddress: command.ipAddress }),
        ...(command.userAgent === null ? {} : { userAgent: command.userAgent }),
      });
      const familyId = asId<AnyId>(session.id);

      // Inside the transaction, so the session and the record that it was opened commit
      // together. A session that exists without a trail is the thing audit is for.
      await this.audit.write(this.actor(tenantId, command, credential.id), {
        action: SecurityAudit.LOGIN_SUCCEEDED,
        subjectType: AuditSubjectType.SESSION,
        subjectId: familyId,
        outcome: AuditOutcome.SUCCESS,
        payload: { userId: credential.id },
      });

      const issued = await this.refreshTokens.issue({
        tenantId: platformTenant(tenantId),
        userId: platformUser(credential.id),
        tokenVersion: credential.permissionVersion,
        familyId: unsafeId<PlatformFamilyId>(familyId),
        sessionId: platformSession(familyId),
      });

      return {
        kind: 'issued',
        result: this.resultFor(credential, familyId, tenantId, issued),
      } as const;
    });

    if (outcome.kind === 'issued') {
      return outcome.result;
    }
    if (outcome.kind === 'mfa-required') {
      // Its own error code, so the client renders the code field rather than "those credentials
      // were not accepted" — which would be untrue and would train people to retype a correct
      // password. Nothing is issued, and nothing is recorded as a failure: not presenting a code
      // that has not been asked for yet is not an attempt.
      throw new MfaRequiredError();
    }

    this.logger.warn('Sign-in rejected', {
      reason: outcome.reason,
      correlationId: command.correlationId,
    });

    // A second, committing transaction. The attempt is recorded whether or not it succeeded,
    // and only then does the request fail.
    await this.withinTenant(command, REJECTED, async (tenantId) => {
      await this.audit.write(this.actor(tenantId, command, null), {
        action: SecurityAudit.LOGIN_FAILED,
        // The subject is the attempt, not a user: for an unknown address there is no user to
        // name, and inventing one would put a fiction in the evidence.
        subjectType: AuditSubjectType.SESSION,
        subjectId: asId<AnyId>(uuidv7(this.clock.now().getTime())),
        outcome: AuditOutcome.DENIED,
        // The reason code, never the address that was tried: the trail says what happened
        // without becoming a list of who does and does not hold an account.
        payload: { reason: outcome.reason },
      });
    });

    throw new UnauthenticatedError(REJECTED);
  }

  async refresh(refreshToken: string, context: SessionContext): Promise<AuthenticationResult> {
    // The transaction below decides the outcome but never throws on the revocation paths.
    // Throwing inside it would roll the revocation back — the exception that reports a stolen
    // token would also erase the record of it, leaving the family live for the next replay.
    //
    // That is why the platform's `rotate` is caught rather than allowed to propagate: it revokes
    // the family and *then* throws, and the throw would undo the revocation it just performed.
    const outcome = await this.withinTenant(context, SESSION_OVER, async (tenantId) => {
      const presented = await this.refreshTokens.inspect(platformTenant(tenantId), refreshToken);
      if (!presented) {
        return { kind: 'reject' } as const;
      }

      // The deadlines the token itself cannot express. `expiresAt` bounds this *token*; the
      // session bounds the *lineage* — a family kept alive by diligent rotation still dies at its
      // absolute deadline, which is the case an idle timeout alone cannot catch.
      const validation = await this.sessionManager.validate(
        platformTenant(tenantId),
        platformSession(asId<AnyId>(presented.familyId)),
      );
      if (!validation.valid) {
        return {
          kind: 'revoke',
          familyId: asId<AnyId>(presented.familyId),
          reason: `SESSION_${validation.reason.toUpperCase().replace(/-/g, '_')}`,
        } as const;
      }

      let rotated;
      try {
        rotated = await this.refreshTokens.rotate(platformTenant(tenantId), refreshToken);
      } catch (error) {
        // Replay, or a concurrent exchange that lost the compare-and-swap — indistinguishable,
        // and treated the same. The platform has already revoked the family by this point.
        if (isPlatformCode(error, 'AUTH_TOKEN_REUSED')) {
          return {
            kind: 'revoke',
            familyId: asId<AnyId>(presented.familyId),
            reason: 'REFRESH_TOKEN_REUSED',
          } as const;
        }
        // Expired or already revoked: no lineage to end, nothing to report beyond the refusal.
        if (
          isPlatformCode(error, 'AUTH_TOKEN_EXPIRED') ||
          isPlatformCode(error, 'AUTH_TOKEN_INVALID')
        ) {
          return { kind: 'reject' } as const;
        }
        throw error;
      }

      const credential = await this.credentials.findById(
        asId<UserId>(rotated.issued.record.userId),
      );
      if (!credential || !canSignIn(credential.status)) {
        // Disabled between refreshes: end the session rather than extend it. The token stays
        // consumed, which is why this transaction is allowed to commit.
        return {
          kind: 'revoke',
          familyId: asId<AnyId>(presented.familyId),
          reason: 'USER_NOT_ELIGIBLE',
        } as const;
      }

      // Rotation is the signal that the lineage is alive, so it is what moves the idle window.
      // The absolute deadline is untouched — `touch` clamps to it rather than extending past it.
      await this.sessionManager.touch(
        platformTenant(tenantId),
        platformSession(asId<AnyId>(presented.familyId)),
        {
          ...(context.ipAddress === null ? {} : { ipAddress: context.ipAddress }),
          ...(context.userAgent === null ? {} : { userAgent: context.userAgent }),
        },
      );

      return {
        kind: 'issued',
        result: this.resultFor(
          credential,
          asId<AnyId>(presented.familyId),
          tenantId,
          rotated.issued,
        ),
      } as const;
    });

    if (outcome.kind === 'issued') {
      return outcome.result;
    }

    if (outcome.kind === 'revoke') {
      // A second, committing transaction. Only now is it safe to fail the request.
      await this.withinTenant(context, SESSION_OVER, async (tenantId) => {
        await this.sessionManager.revoke(
          platformTenant(tenantId),
          platformSession(outcome.familyId),
          outcome.reason === 'REFRESH_TOKEN_REUSED' ? 'token-reuse' : 'account-disabled',
        );
        await this.audit.write(this.actor(tenantId, context, null), {
          action: SecurityAudit.SESSION_REVOKED,
          subjectType: AuditSubjectType.SESSION,
          subjectId: outcome.familyId,
          outcome: AuditOutcome.DENIED,
          payload: { reason: outcome.reason },
        });
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
    await this.withinTenant(context, SESSION_OVER, async (tenantId) => {
      const presented = await this.refreshTokens.inspect(platformTenant(tenantId), refreshToken);
      // Unknown or already revoked is success: sign-out is idempotent, and reporting "no such
      // session" would tell an attacker which stolen tokens are still live.
      if (presented && presented.revokedAt === undefined) {
        await this.sessionManager.revoke(
          platformTenant(tenantId),
          platformSession(asId<AnyId>(presented.familyId)),
          'logout',
        );
        // The lineage as well as the session: a token left live after sign-out is a credential the
        // user believes they have surrendered.
        await this.refreshTokens.revokeFamily(
          platformTenant(tenantId),
          presented.familyId,
          'logout',
        );
        await this.audit.write(this.actor(tenantId, context, asId<UserId>(presented.userId)), {
          action: SecurityAudit.SESSION_REVOKED,
          subjectType: AuditSubjectType.SESSION,
          subjectId: asId<AnyId>(presented.familyId),
          outcome: AuditOutcome.SUCCESS,
          payload: { reason: 'SIGNED_OUT' },
        });
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

  /**
   * Who the audit trail records as having acted.
   *
   * The channel is `API` because that is what this surface is; a browser reaching it through
   * the web client is still an API call, and pretending otherwise would put a guess in the
   * evidence.
   */
  private actor(tenantId: TenantId, context: SessionContext, userId: UserId | null): AuditActor {
    return {
      tenantId,
      userId,
      channel: 'API',
      correlationId: context.correlationId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    };
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

  /**
   * Build the response around a refresh token the platform has already minted.
   *
   * The access token stays this product's: it carries Docs' roles, permissions and permission
   * version, which the platform's token service knows nothing about. Only the refresh half moved.
   */
  private resultFor(
    credential: UserCredentialRecord,
    familyId: AnyId,
    tenantId: TenantId,
    issued: IssuedRefreshToken,
  ): AuthenticationResult {
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
      refreshToken: issued.token,
      refreshTokenExpiresAt: new Date(issued.record.expiresAt),
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
