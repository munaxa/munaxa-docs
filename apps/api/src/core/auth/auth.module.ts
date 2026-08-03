import { type DynamicModule, Global, Module, type Type } from '@nestjs/common';

import { TOKEN_VERIFIER, type TokenVerifier } from './access-token';
import { AuthenticationGuard } from './authentication.guard';
import { AuthenticationMiddleware } from './authentication.middleware';
import { NoIssuerTokenVerifier } from './no-issuer.token-verifier';

/**
 * Authentication wiring.
 *
 * `TOKEN_VERIFIER` belongs to the Identity module, which owns sessions and signing keys — but
 * `core/` may not import a module, by lint rule as well as by design. So the composition root
 * supplies the class and this module binds it:
 * `AuthModule.withVerifier(JwtTokenService)`.
 *
 * Imported plainly, without a verifier, the port resolves to one that rejects every token: the
 * process boots and serves its health probes, and nothing behind the authentication guard is
 * reachable. That is the right posture for a deployment whose identity provider is not
 * configured, and it is what this module did for the whole of Phase 0.5.
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
export class AuthModule {
  /**
   * Binds a real verifier.
   *
   * The class is registered here rather than merely aliased elsewhere, because
   * `AuthenticationMiddleware` is declared in this module and therefore resolves
   * `TOKEN_VERIFIER` from this module's own scope. A binding added in the composition root
   * instead would be invisible to the one consumer that matters most.
   */
  static withVerifier(verifier: Type<TokenVerifier>): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      providers: [
        AuthenticationGuard,
        AuthenticationMiddleware,
        verifier,
        { provide: TOKEN_VERIFIER, useExisting: verifier },
      ],
      exports: [AuthenticationGuard, AuthenticationMiddleware, TOKEN_VERIFIER],
    };
  }
}
