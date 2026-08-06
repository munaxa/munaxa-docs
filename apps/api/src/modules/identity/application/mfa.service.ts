import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, AuditOutcome, AuditSubjectType, type UserId, asId } from '@edms/domain';

import { AUDIT_WRITER, type AuditWriter } from '../../../core/audit/audit-writer.port';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { SecurityAudit } from '../domain/audit-actions';
import {
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  totpUri,
  verifyTotp,
} from '../domain/totp';
import {
  MFA_REPOSITORY,
  type MfaConfirmation,
  type MfaEnrolmentOffer,
  type MfaRepository,
  type MfaService,
  type MfaStatus,
} from './mfa.ports';
import { unsafeId } from '@munaxa/types';
import type { TenantId as PlatformTenantId, UserId as PlatformUserId } from '@munaxa/types';
import type { SessionRevocationReason } from '@munaxa/interfaces';

import {
  SESSION_MANAGER,
  type PlatformSessionManager,
} from '../infrastructure/session-manager.provider';
import { requireContext } from '../../../core/tenancy/tenant-context';

/**
 * The second factor: enrolling one, proving it, and answering a challenge with it.
 *
 * ## Two rows of `13-audit-architecture.md` §2, and one that was already written
 *
 * `MFA_ENROLLED` and `MFA_FAILED` are §2's, attributed to this phase and written here for the
 * first time. `SESSION_REVOKED` is the third row §2's ownership table lists as owed — and it was
 * **already written**, by Phase 1's refresh-replay detection. The table was stale rather than the
 * code incomplete; this service adds a third call site rather than the first.
 *
 * ## Five decisions, each with a cost
 *
 * **Enrolment is two steps and the first one grants nothing.** A secret is issued, and the
 * enrolment stays unconfirmed until a code proves the authenticator holds it. An enrolment that
 * flipped `mfa_enrolled` on issue would lock somebody out of their own account the moment their
 * phone failed to scan the code.
 *
 * **A used step cannot be used again.** The step a code belongs to is stored, and a code whose step
 * is not *greater* than the last is refused even when it is arithmetically correct — which closes
 * the thirty-second window in which a shoulder-surfed code is still live.
 *
 * **A failure counts, and enough of them stop the factor.** `MFA_MAX_FAILED_ATTEMPTS` consecutive
 * failures refuse until an administrator un-enrols, because a six-digit code is a million
 * possibilities and an unbounded challenge endpoint is an afternoon's work to brute-force.
 *
 * **Recovery codes are single-use and are the *only* way past a lost authenticator.** There is no
 * "email me a bypass": a bypass sent to an address is a second factor that is the first factor's
 * mailbox. What there is instead is an administrator with `user:manage` who can un-enrol somebody,
 * which is a human decision recorded in the trail.
 *
 * **Enrolling and un-enrolling both end every session.** The set of factors that opened a session
 * is part of what the session means, and a session opened before a factor existed is one that
 * outlives the decision to require one.
 *
 * ## What this deliberately does not do
 *
 * Enforce a policy. 17 §2 says MFA is "required by policy for `TENANT_ADMIN`,
 * `DOCUMENT_CONTROLLER` and `AUDITOR`; available to all", and `isRequired` answers only the second
 * half — whether *this person* has enrolled. Making the first half true means refusing a sign-in
 * from somebody who holds a role and has not enrolled, which is a lock-out of exactly the accounts
 * that administer the tenant, on the deployment where nobody has enrolled yet. It belongs with the
 * federation half of 17 §2, where an operator can be given a way out; the phase report says so.
 */
@Injectable()
export class DefaultMfaService implements MfaService {
  /**
   * End every session a user holds, through the platform.
   *
   * The tenant comes from the ambient request context rather than from a parameter, matching the
   * repositories this replaced: a tenant a caller supplies is a tenant a caller can get wrong, and
   * row-level security would then report it as a constraint error rather than as the bug it is.
   */
  private async revokeEverySession(userId: UserId, reason: SessionRevocationReason): Promise<void> {
    await this.sessionManager.revokeAllForUser(
      unsafeId<PlatformTenantId>(requireContext().tenantId),
      unsafeId<PlatformUserId>(userId),
      reason,
    );
  }

  constructor(
    @Inject(MFA_REPOSITORY) private readonly enrolments: MfaRepository,
    @Inject(SESSION_MANAGER) private readonly sessionManager: PlatformSessionManager,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async statusFor(userId: UserId): Promise<MfaStatus> {
    return this.unitOfWork.run(async () => {
      const enrolment = await this.enrolments.findFor(userId);
      if (enrolment === null) {
        return { enrolled: false, pending: false, recoveryCodesRemaining: 0 };
      }
      return {
        enrolled: enrolment.confirmedAt !== null,
        pending: enrolment.confirmedAt === null,
        recoveryCodesRemaining:
          enrolment.confirmedAt === null
            ? 0
            : await this.enrolments.countLiveRecoveryCodes(enrolment.id),
      };
    });
  }

  async begin(userId: UserId, account: string): Promise<MfaEnrolmentOffer> {
    return this.unitOfWork.run(async () => {
      const existing = await this.enrolments.findFor(userId);
      if (existing?.confirmedAt != null) {
        // Refused rather than silently replaced. Re-enrolling would invalidate the recovery codes
        // somebody may be holding on paper, and doing that as a side effect of opening a screen is
        // how people lose their last way in.
        throw new ForbiddenError(
          'An authenticator is already enrolled. Remove it before enrolling another.',
        );
      }
      const secret = generateTotpSecret();
      await this.enrolments.startEnrolment(userId, secret);
      return {
        secret,
        uri: totpUri({
          secret,
          account,
          issuer: this.config.app.name,
          digits: this.config.mfa.totpDigits,
          stepSeconds: this.config.mfa.totpStepSeconds,
        }),
        digits: this.config.mfa.totpDigits,
        stepSeconds: this.config.mfa.totpStepSeconds,
      };
    });
  }

  /**
   * Proves the authenticator holds the secret.
   *
   * The transaction decides and does **not** throw, for the reason `signIn` gives about a failed
   * sign-in: a refused attempt is exactly the event somebody would prefer to leave no trace of, and
   * throwing inside the unit of work would roll `MFA_FAILED` back along with everything else. The
   * refusal is committed in its own transaction, and only then does the request fail. This suite
   * caught that; it was written the other way first.
   */
  async confirm(userId: UserId, code: string): Promise<MfaConfirmation> {
    const outcome = await this.unitOfWork.run(async () => {
      const enrolment = await this.enrolments.findFor(userId);
      if (enrolment === null) {
        throw new NotFoundError('Authenticator enrolment');
      }
      if (enrolment.confirmedAt !== null) {
        throw new ForbiddenError('That authenticator is already confirmed.');
      }
      const step = verifyTotp(enrolment.secret, code, {
        step: this.currentStep(),
        digits: this.config.mfa.totpDigits,
        skewSteps: this.config.mfa.totpSkewSteps,
      });
      if (step === null) {
        return { kind: 'refused' } as const;
      }

      const codes = Array.from({ length: this.config.mfa.recoveryCodeCount }, () =>
        generateRecoveryCode(),
      );
      await this.enrolments.confirm(
        enrolment.id,
        userId,
        step,
        codes.map((value) => hashRecoveryCode(normalizeRecoveryCode(value))),
      );
      // Every session ends, including the one being used to enrol. The set of factors that opened a
      // session is part of what it means, and a session opened before the factor existed outlives
      // the decision to have one.
      await this.revokeEverySession(userId, 'mfa-changed');

      await this.write(SecurityAudit.MFA_ENROLLED, userId, AuditOutcome.SUCCESS, {
        method: 'TOTP',
        recoveryCodes: codes.length,
      });
      await this.write(SecurityAudit.SESSION_REVOKED, userId, AuditOutcome.SUCCESS, {
        reason: 'MFA_ENROLLED',
      });

      return { kind: 'confirmed', recoveryCodes: codes } as const;
    });

    if (outcome.kind === 'confirmed') {
      return { recoveryCodes: outcome.recoveryCodes };
    }

    await this.unitOfWork.run(() => this.recordFailure(userId, 'CONFIRM'));
    throw new ValidationError('That code did not match the authenticator.', [
      { field: 'code', message: 'Not the code this authenticator is showing.' },
    ]);
  }

  async challenge(userId: UserId, code: string): Promise<boolean> {
    return this.unitOfWork.run(async () => {
      const enrolment = await this.enrolments.findFor(userId);
      if (enrolment === null || enrolment.confirmedAt === null) {
        // Nothing is owed. `true` rather than an error: the caller asks "is this challenge
        // satisfied", and an account with no factor satisfies it by having none.
        return true;
      }
      if (enrolment.failedAttempts >= this.config.mfa.maxFailedAttempts) {
        await this.recordFailure(userId, 'LOCKED');
        return false;
      }

      const step = verifyTotp(enrolment.secret, code, {
        step: this.currentStep(),
        digits: this.config.mfa.totpDigits,
        skewSteps: this.config.mfa.totpSkewSteps,
      });
      // Strictly greater, not merely valid: the window a code is arithmetically correct for is
      // thirty seconds wide, and one already spent inside it is a replay.
      if (step !== null && (enrolment.lastStep === null || step > enrolment.lastStep)) {
        await this.enrolments.recordSuccess(enrolment.id, step);
        if (enrolment.staleSeal) {
          // Phase 18's key rotation, completed one person at a time. This is the only moment the
          // plaintext secret and a successful proof of it exist together, which is what makes it
          // the only place a re-seal can happen without holding every tenant's secrets in one
          // process. In the same transaction as the success, so a crash between the two leaves the
          // row readable under the old key rather than half-rotated.
          await this.enrolments.reseal(enrolment.id, enrolment.secret);
        }
        return true;
      }
      if (step === null && (await this.tryRecoveryCode(enrolment.id, code))) {
        return true;
      }

      await this.enrolments.recordFailure(enrolment.id);
      await this.recordFailure(userId, step === null ? 'BAD_CODE' : 'REPLAYED');
      return false;
    });
  }

  async isRequired(userId: UserId): Promise<boolean> {
    return this.unitOfWork.run(async () => {
      const enrolment = await this.enrolments.findFor(userId);
      return enrolment !== null && enrolment.confirmedAt !== null;
    });
  }

  async remove(userId: UserId): Promise<void> {
    await this.unitOfWork.run(async () => {
      const enrolment = await this.enrolments.findFor(userId);
      if (enrolment === null) {
        throw new NotFoundError('Authenticator enrolment');
      }
      await this.enrolments.remove(userId);
      await this.revokeEverySession(userId, 'mfa-changed');
      await this.write(SecurityAudit.MFA_ENROLLED, userId, AuditOutcome.SUCCESS, {
        method: 'TOTP',
        removed: true,
      });
      await this.write(SecurityAudit.SESSION_REVOKED, userId, AuditOutcome.SUCCESS, {
        reason: 'MFA_REMOVED',
      });
    });
  }

  // --- Internals ---------------------------------------------------------------------------

  /**
   * A recovery code, spent.
   *
   * Compared against the stored hashes rather than looked up by one, because the codes are hashed
   * with a fixed salt and a lookup would be the same query — but the loop is what keeps the shape
   * honest if the hashing ever gains a per-row salt.
   */
  private async tryRecoveryCode(enrolmentId: AnyId, presented: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(presented);
    if (normalized === '') {
      return false;
    }
    const wanted = hashRecoveryCode(normalized);
    const live = await this.enrolments.liveRecoveryCodes(enrolmentId);
    const match = live.find((candidate) => candidate.codeHash === wanted);
    if (match === undefined) {
      return false;
    }
    await this.enrolments.markRecoveryCodeUsed(match.id, this.clock.now());
    await this.enrolments.recordSuccess(enrolmentId, this.currentStep());
    return true;
  }

  private currentStep(): number {
    return Math.floor(this.clock.now().getTime() / 1_000 / this.config.mfa.totpStepSeconds);
  }

  /** `MFA_FAILED` — 13 §2's row, and the reason code, never the code that was tried. */
  private async recordFailure(userId: UserId, reason: string): Promise<void> {
    await this.write(SecurityAudit.MFA_FAILED, userId, AuditOutcome.DENIED, { reason });
  }

  private async write(
    action: string,
    userId: UserId,
    outcome: (typeof AuditOutcome)[keyof typeof AuditOutcome],
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const context = requireContext();
    await this.audit.write(
      {
        tenantId: context.tenantId,
        userId: context.userId,
        channel: 'API',
        correlationId: context.correlationId,
        ipAddress: null,
        userAgent: null,
      },
      {
        action,
        // The **session** subject type, like every other row in the Security group: an
        // authenticator is something an account signs in with, and filing it under `USER` would put
        // it on the administration timeline beside "their address changed".
        subjectType: AuditSubjectType.SESSION,
        subjectId: asId<AnyId>(userId),
        outcome,
        payload,
      },
    );
  }
}
