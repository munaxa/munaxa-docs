import { Injectable } from '@nestjs/common';

import { UnauthenticatedError } from '../errors/application-errors';
import type { AccessTokenClaims, TokenVerifier } from './access-token';

/**
 * The verifier in force until the Identity module binds the real one.
 *
 * It rejects every token. Nobody can authenticate, which means nothing behind the
 * authentication guard is reachable — the correct posture for a system whose session
 * handling, signing keys and MFA policy do not exist yet.
 *
 * The alternative — accepting an unsigned token so that development is convenient — is how a
 * "temporary" authentication bypass reaches production
 * (`docs/architecture/17-security-architecture.md` §10).
 */
@Injectable()
export class NoIssuerTokenVerifier implements TokenVerifier {
  verify(_token: string): Promise<AccessTokenClaims> {
    return Promise.reject(
      new UnauthenticatedError('No token issuer is configured for this deployment.'),
    );
  }
}
