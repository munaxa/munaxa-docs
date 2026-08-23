import { type DynamicModule, Global, Module, type Type } from '@nestjs/common';

import { TOKEN_VERIFIER, type TokenVerifier } from './access-token';
import { AuthenticationGuard } from './authentication.guard';
import { AuthenticationMiddleware } from './authentication.middleware';
import { NoIssuerTokenVerifier } from './no-issuer.token-verifier';
import { PERMISSION_VERSION_READER, type PermissionVersionReader } from './permission-version';
import { UnavailablePermissionVersionReader } from './unavailable.permission-version';

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
 *
 * ## `API_KEY_AUTHENTICATOR` is bound differently, and Phase 17 found out why
 *
 * It was written as a second argument to `withVerifier` first, by symmetry, and that does not
 * work: a class registered *inside* this module resolves its own dependencies from this module's
 * scope, and the machine-credential resolver needs Identity's credential repository and settings
 * reader. `JwtTokenService` gets away with it because it depends on configuration alone.
 *
 * So the token stays declared here — `core/` may not import a module — and the binding *and* the
 * middleware that consumes it are both provided by the composition root, which is the one place
 * that may import both. `AppModule` therefore declares `AuthenticationMiddleware` in its own
 * providers, and the instance Nest applies is resolved in that scope.
 */
@Global()
@Module({
  providers: [
    AuthenticationGuard,
    AuthenticationMiddleware,
    { provide: TOKEN_VERIFIER, useClass: NoIssuerTokenVerifier },
    { provide: PERMISSION_VERSION_READER, useClass: UnavailablePermissionVersionReader },
  ],
  exports: [
    AuthenticationGuard,
    AuthenticationMiddleware,
    TOKEN_VERIFIER,
    PERMISSION_VERSION_READER,
  ],
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
  static withVerifier(
    verifier: Type<TokenVerifier>,
    /**
     * The authoritative permission generation — Slice 31.
     *
     * A parameter for the same reason the verifier is one. `AuthenticationGuard` is declared in
     * this module and therefore resolves its dependencies from this module's scope, and the real
     * reader lives in Identity's infrastructure, which `core/` may not import. Passing the class
     * lets the composition root — the one place that may import both — choose it, while the
     * registration happens here where the consumer can see it.
     *
     * Optional, and the default refuses rather than waves through: see
     * `UnavailablePermissionVersionReader`.
     */
    versions: Type<PermissionVersionReader> = UnavailablePermissionVersionReader,
  ): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      providers: [
        AuthenticationGuard,
        AuthenticationMiddleware,
        verifier,
        versions,
        { provide: TOKEN_VERIFIER, useExisting: verifier },
        { provide: PERMISSION_VERSION_READER, useExisting: versions },
      ],
      exports: [
        AuthenticationGuard,
        AuthenticationMiddleware,
        TOKEN_VERIFIER,
        PERMISSION_VERSION_READER,
      ],
    };
  }
}
