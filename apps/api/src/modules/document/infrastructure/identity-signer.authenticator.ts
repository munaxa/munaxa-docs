import { Inject, Injectable } from '@nestjs/common';

import type { UserId } from '@edms/domain';

import { CREDENTIAL_REPOSITORY, type CredentialRepository } from '../../identity/application/ports';
import {
  PASSWORD_HASHER,
  type PasswordHasher,
} from '../../identity/application/authentication.ports';
import { MFA_SERVICE, type MfaService } from '../../identity/application/mfa.ports';
import type { SignerAuthenticator } from '../application/signature.ports';

/**
 * Re-proving a signer's credentials — 21 CFR Part 11 §11.200, answered by Identity.
 *
 * The adapter sits in Document's `infrastructure/` and reaches Identity's application layer, which
 * is the ordinary downward direction: Identity sits above Document in the module order and owns
 * credentials. What it deliberately does *not* do is duplicate `AuthenticationService.signIn` —
 * that method issues a session, rotates a refresh family, records a sign-in and audits an outcome,
 * and none of those should happen because somebody signed a document. What is shared is the two
 * checks themselves, through the same collaborators `signIn` uses.
 *
 * **Every failure is the same failure.** A wrong password, no password set, an owed factor not
 * supplied and a wrong code all answer false, and the caller turns that into one refusal.
 * Distinguishing them would tell somebody holding a stolen session which half of the credentials
 * they still need — the same reasoning that makes `signIn` fail identically for an unknown address
 * and a wrong password.
 */
@Injectable()
export class IdentitySignerAuthenticator implements SignerAuthenticator {
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(MFA_SERVICE) private readonly mfa: MfaService,
  ) {}

  async reauthenticate(input: {
    readonly userId: UserId;
    readonly password: string | null;
    readonly mfaCode: string | null;
  }): Promise<boolean> {
    if (input.password === null || input.password.length === 0) {
      return false;
    }
    const credential = await this.credentials.findById(input.userId);
    if (credential === null || !credential.passwordHash) {
      return false;
    }
    if (!(await this.passwords.verify(input.password, credential.passwordHash))) {
      return false;
    }

    // The second factor, when this person has one. `isRequired` answers false for somebody not
    // enrolled, so a tenant that has not adopted TOTP still gets a §11.200-shaped signature from
    // the password plus the session — two components, which is what the rule asks for.
    if (!(await this.mfa.isRequired(input.userId))) {
      return true;
    }
    if (input.mfaCode === null || input.mfaCode.length === 0) {
      return false;
    }
    // Through `MfaService.challenge` rather than a second verification here, so the recovery-code
    // path, the replay window and the audit rows Phase 14 built all apply to a signature exactly as
    // they apply to a sign-in.
    return (await this.mfa.challenge(input.userId, input.mfaCode)) === true;
  }
}
