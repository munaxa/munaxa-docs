import { Module } from '@nestjs/common';

import {
  ACCESS_TOKEN_ISSUER,
  AUTHENTICATION_SERVICE,
  PASSWORD_HASHER,
  REFRESH_TOKEN_FACTORY,
  TENANT_DIRECTORY,
} from './application/authentication.ports';
import { DefaultMfaService } from './application/mfa.service';
import { MFA_REPOSITORY, MFA_SERVICE } from './application/mfa.ports';
import { PrismaMfaRepository } from './infrastructure/prisma-mfa.repository';
import { DefaultAuthenticationService } from './application/authentication.service';
import {
  CREDENTIAL_REPOSITORY,
  DELEGATION_REPOSITORY,
  DELEGATION_SERVICE,
  PROVISIONING_REPOSITORY,
  SESSION_REPOSITORY,
  USER_DIRECTORY,
} from './application/ports';
import { DefaultDelegationService } from './application/delegation.service';
import { ProvisioningService } from './application/provisioning.service';
import {
  IDENTITY_ADMIN_REPOSITORY,
  ROLE_ADMIN_SERVICE,
  USER_ADMIN_SERVICE,
} from './application/administration.ports';
import { RoleAdminService } from './application/role-admin.service';
import { UserAdminService } from './application/user-admin.service';
import { JwtTokenService } from './infrastructure/jwt.token-service';
import { PrismaCredentialRepository } from './infrastructure/prisma-credential.repository';
import { DelegationLaneConsumer } from './infrastructure/delegation-lane.consumer';
import { PrismaDelegationRepository } from './infrastructure/prisma-delegation.repository';
import { PrismaIdentityAdminRepository } from './infrastructure/prisma-identity-admin.repository';
import { PrismaProvisioningRepository } from './infrastructure/prisma-provisioning.repository';
import { PrismaSessionRepository } from './infrastructure/prisma-session.repository';
import { RegistryTenantDirectory } from './infrastructure/registry-tenant.directory';
import { PrismaUserDirectory } from './infrastructure/prisma-user.directory';
import { RandomRefreshTokenFactory } from './infrastructure/random-refresh-token.factory';
import { ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher';
import { MfaController } from './presentation/mfa.controller';
import { AuthController } from './presentation/auth.controller';
import { DelegationController } from './presentation/delegation.controller';
import { RoleAdminController, UserAdminController } from './presentation/identity-admin.controller';

import { IdentityDashboardMetrics } from './infrastructure/dashboard-metrics.adapter';
import { IdentityDashboardDelegationMetrics } from './infrastructure/dashboard-delegation.adapter';
import {
  DASHBOARD_DELEGATION_METRICS,
  DASHBOARD_PEOPLE_METRICS,
} from '../dashboard/application/ports';
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
 * Phase 1 implemented authentication: sign-in, refresh with rotation and reuse detection, and
 * sign-out. Phase 2 adds the administration of people and access — users, roles, the permission
 * matrix and the eight seeded roles — behind `user:manage` and `role:manage`. Phase 11 binds
 * `DELEGATION_REPOSITORY` and `DELEGATION_SERVICE`, declared and unbound since Phase 0.5, and
 * with them the `identity.delegation` lane. MFA arrives with the phase that owns it; see
 * `README.md` in this folder.
 *
 * The administration services are **not exported**. Nothing outside this module has any business
 * creating a user or editing a role, and `USER_DIRECTORY` remains the whole of what other modules
 * may know about a person: an address and a name.
 */
@Module({
  controllers: [
    AuthController,
    MfaController,
    UserAdminController,
    RoleAdminController,
    DelegationController,
  ],
  providers: [
    // Phase 13: account counts for the administrator tile, and Phase 11's deferred delegation
    // card — both answered by the module that owns the tables, never read from the dashboard.
    { provide: DASHBOARD_PEOPLE_METRICS, useClass: IdentityDashboardMetrics },
    { provide: DASHBOARD_DELEGATION_METRICS, useClass: IdentityDashboardDelegationMetrics },
    { provide: AUTHENTICATION_SERVICE, useClass: DefaultAuthenticationService },
    // Phase 14: the second factor. `user.mfa_enrolled` has been read by the auth response and the
    // admin view since Phase 1 and written by nothing; these two bindings are what write it.
    { provide: MFA_REPOSITORY, useClass: PrismaMfaRepository },
    { provide: MFA_SERVICE, useClass: DefaultMfaService },
    { provide: CREDENTIAL_REPOSITORY, useClass: PrismaCredentialRepository },
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: TENANT_DIRECTORY, useClass: RegistryTenantDirectory },
    { provide: USER_DIRECTORY, useClass: PrismaUserDirectory },
    { provide: PROVISIONING_REPOSITORY, useClass: PrismaProvisioningRepository },
    ProvisioningService,
    { provide: IDENTITY_ADMIN_REPOSITORY, useClass: PrismaIdentityAdminRepository },
    { provide: USER_ADMIN_SERVICE, useClass: UserAdminService },
    { provide: ROLE_ADMIN_SERVICE, useClass: RoleAdminService },
    { provide: DELEGATION_REPOSITORY, useClass: PrismaDelegationRepository },
    { provide: DELEGATION_SERVICE, useClass: DefaultDelegationService },
    // The lane's consumer, declared here rather than in a worker for the reason every consumer
    // since Phase 4 is: `apps/worker` composes none of the domain modules.
    DelegationLaneConsumer,
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    { provide: REFRESH_TOKEN_FACTORY, useClass: RandomRefreshTokenFactory },
    // The issuer and the verifier are one class: they share the secret, the algorithm and the
    // claim shape, and splitting them is how a signer and a checker drift apart.
    JwtTokenService,
    { provide: ACCESS_TOKEN_ISSUER, useExisting: JwtTokenService },
  ],
  exports: [
    DASHBOARD_PEOPLE_METRICS,
    DASHBOARD_DELEGATION_METRICS,
    AUTHENTICATION_SERVICE,
    // Phase 3: a metadata field of type USER names somebody, and Document checks that the
    // somebody exists. Through this service, never by reading Identity's tables.
    USER_ADMIN_SERVICE,
    PASSWORD_HASHER,
    CREDENTIAL_REPOSITORY,
    USER_DIRECTORY,
    // Phase 11: the workflow engine asks whether one person may decide for another, and the
    // approval inbox asks whom a delegate may act for. Through this service, never by reading
    // Identity's tables.
    DELEGATION_SERVICE,
    ProvisioningService,
  ],
})
export class IdentityModule {}
