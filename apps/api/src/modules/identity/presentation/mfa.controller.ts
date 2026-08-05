import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { z } from 'zod';

import { Permission, type UserId, asId } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { UnauthenticatedError } from '../../../core/errors/application-errors';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  MFA_SERVICE,
  type MfaConfirmation,
  type MfaEnrolmentOffer,
  type MfaService,
  type MfaStatus,
} from '../application/mfa.ports';
import { CREDENTIAL_REPOSITORY, type CredentialRepository } from '../application/ports';

const codeSchema = z.object({ code: z.string().min(1).max(32) });

/**
 * A person's own authenticator.
 *
 * **Every route here is about the caller and takes no user identifier**, which is the same
 * enforcement-by-absence `delegation:manage` and `notification:manage` use: there is no request by
 * which one person could enrol, confirm or remove another's factor, whatever they hold. An
 * administrator who must un-enrol somebody — the lost-phone-and-lost-recovery-codes case — does it
 * through the user administration surface, where it is a `user:manage` act with a name attached.
 *
 * `notification:manage` gates it, and that choice needs a sentence. 15 §5 asserts at boot that
 * every mutating route declares a permission; enrolling a second factor is not a document act, not
 * an administrative one, and not public. The only existing key whose meaning is "this person's own
 * arrangements about their own account, held by everybody including `GUEST`" is
 * `notification:manage` — 08 §6's own note calls it exactly that, "a person's own inbox and their
 * own preferences", and everybody who can sign in must be able to secure their sign-in. Inventing
 * `mfa:manage` was the alternative and was rejected: it would be a permission granted to every role
 * with no case in which it is ever withheld, which is a row in the matrix that means nothing.
 */
@Controller({ path: 'auth/mfa', version: '1' })
@RequirePermission(Permission.NOTIFICATION_MANAGE)
export class MfaController {
  constructor(
    @Inject(MFA_SERVICE) private readonly mfa: MfaService,
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
  ) {}

  @Get()
  async status(): Promise<MfaStatus> {
    return this.mfa.statusFor(this.caller());
  }

  /**
   * Issues a secret. The response carries it exactly once and no read path returns it again.
   *
   * A `POST` for a call that reads like a fetch, because it is not one: it mints a secret and
   * replaces any unconfirmed enrolment. A `GET` that did that would be re-run by a prefetch.
   */
  @Post('enrolment')
  @HttpCode(HttpStatus.OK)
  async begin(): Promise<MfaEnrolmentOffer> {
    const userId = this.caller();
    const credential = await this.credentials.findById(userId);
    // The account's own address, so the entry in the authenticator says who it is for. A person
    // with three tenants sees three entries and needs to tell them apart.
    return this.mfa.begin(userId, credential?.email ?? String(userId));
  }

  /** Proves the authenticator holds the secret, and returns the recovery codes once. */
  @Post('enrolment/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Body(new ZodValidationPipe(codeSchema)) body: { code: string },
  ): Promise<MfaConfirmation> {
    return this.mfa.confirm(this.caller(), body.code);
  }

  /**
   * Removes the caller's own authenticator.
   *
   * No confirmation code required, and that is deliberate: the caller is already holding a live
   * session, which they obtained *with* the factor. Demanding a second proof to remove something
   * they have just proved they hold would be ceremony; the control that matters is that every
   * session ends afterwards, which the service does.
   */
  @Delete('enrolment')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(): Promise<void> {
    await this.mfa.remove(this.caller());
  }

  private caller(): UserId {
    const { userId } = requireContext();
    if (userId === null) {
      throw new UnauthenticatedError('Sign in to manage your authenticator.');
    }
    return asId<UserId>(userId);
  }
}
