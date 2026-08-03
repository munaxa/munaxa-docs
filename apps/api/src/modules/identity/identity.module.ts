import { Module } from '@nestjs/common';

/**
 * Identity — Who is this person, and what may they do anywhere?
 *
 * **Owns:** User, Role, RolePermission, UserRole, sessions, MFA enrolment, Delegation
 * **Depends on:** — (nothing; every other module depends on it)
 *
 * `TOKEN_VERIFIER` — it owns sessions and signing keys, so core declares the port and this module supplies it.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class IdentityModule {}
