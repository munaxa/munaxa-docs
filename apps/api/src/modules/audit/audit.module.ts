import { Module } from '@nestjs/common';

/**
 * Audit — What happened, when, by whom — provably?
 *
 * **Owns:** AuditEvent, the hash chain, evidence export
 * **Depends on:** — (written by every module through the audit port)
 *
 * `AUDIT_WRITER` — it owns the chain, so it owns the only way to append to it.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class AuditModule {}
