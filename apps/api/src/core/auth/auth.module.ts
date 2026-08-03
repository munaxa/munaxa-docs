import { Global, Module } from '@nestjs/common';

import { TOKEN_VERIFIER } from './access-token';
import { AuthenticationGuard } from './authentication.guard';
import { AuthenticationMiddleware } from './authentication.middleware';
import { NoIssuerTokenVerifier } from './no-issuer.token-verifier';

/**
 * Authentication wiring.
 *
 * `TOKEN_VERIFIER` belongs to the Identity module, which owns sessions and signing keys. Until
 * that module binds it, the port resolves to a verifier that rejects every token: the process
 * boots and serves its health probes, and nothing behind the authentication guard is
 * reachable. Identity overrides this binding when it ships.
 */
@Global()
@Module({
  providers: [
    AuthenticationGuard,
    AuthenticationMiddleware,
    { provide: TOKEN_VERIFIER, useClass: NoIssuerTokenVerifier },
  ],
  exports: [AuthenticationGuard, AuthenticationMiddleware, TOKEN_VERIFIER],
})
export class AuthModule {}
