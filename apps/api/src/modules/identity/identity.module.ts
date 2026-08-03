import { Module } from '@nestjs/common';

import {
  ACCESS_TOKEN_ISSUER,
  AUTHENTICATION_SERVICE,
  PASSWORD_HASHER,
  REFRESH_TOKEN_FACTORY,
  TENANT_DIRECTORY,
} from './application/authentication.ports';
import { DefaultAuthenticationService } from './application/authentication.service';
import {
  CREDENTIAL_REPOSITORY,
  PROVISIONING_REPOSITORY,
  SESSION_REPOSITORY,
  USER_DIRECTORY,
} from './application/ports';
import { ProvisioningService } from './application/provisioning.service';
import { JwtTokenService } from './infrastructure/jwt.token-service';
import { PrismaCredentialRepository } from './infrastructure/prisma-credential.repository';
import { PrismaProvisioningRepository } from './infrastructure/prisma-provisioning.repository';
import { PrismaSessionRepository } from './infrastructure/prisma-session.repository';
import { PrismaTenantDirectory } from './infrastructure/prisma-tenant.directory';
import { PrismaUserDirectory } from './infrastructure/prisma-user.directory';
import { RandomRefreshTokenFactory } from './infrastructure/random-refresh-token.factory';
import { ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher';
import { AuthController } from './presentation/auth.controller';

/**
 * Identity — Who is this person, and what may they do anywhere?
 *
 * **Owns:** User, Role, RolePermission, UserRole, sessions, MFA enrolment, Delegation
 * **Depends on:** — (nothing; every other module depends on it)
 *
 * `TOKEN_VERIFIER` — it owns sessions and signing keys, so core declares the port and this
 * module supplies it. The binding itself is made by the composition root, which passes
 * `JwtTokenService` to `AuthModule.withVerifier()`: `core/` may not import a module, so the
 * one place that may import both is where they are joined.
 *
 * Phase 1 implements authentication: sign-in, refresh with rotation and reuse detection, and
 * sign-out. User and role administration follow in this module; delegation and MFA arrive
 * with the phases that own them — see `README.md` in this folder.
 */
@Module({
  controllers: [AuthController],
  providers: [
    { provide: AUTHENTICATION_SERVICE, useClass: DefaultAuthenticationService },
    { provide: CREDENTIAL_REPOSITORY, useClass: PrismaCredentialRepository },
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: TENANT_DIRECTORY, useClass: PrismaTenantDirectory },
    { provide: USER_DIRECTORY, useClass: PrismaUserDirectory },
    { provide: PROVISIONING_REPOSITORY, useClass: PrismaProvisioningRepository },
    ProvisioningService,
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    { provide: REFRESH_TOKEN_FACTORY, useClass: RandomRefreshTokenFactory },
    // The issuer and the verifier are one class: they share the secret, the algorithm and the
    // claim shape, and splitting them is how a signer and a checker drift apart.
    JwtTokenService,
    { provide: ACCESS_TOKEN_ISSUER, useExisting: JwtTokenService },
  ],
  exports: [
    AUTHENTICATION_SERVICE,
    PASSWORD_HASHER,
    CREDENTIAL_REPOSITORY,
    USER_DIRECTORY,
    ProvisioningService,
  ],
})
export class IdentityModule {}
