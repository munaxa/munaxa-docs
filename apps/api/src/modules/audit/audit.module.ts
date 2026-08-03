import { Global, Module } from '@nestjs/common';

import { ACTIVITY_READER } from '../../core/activity/activity.port';
import { AUDIT_WRITER } from '../../core/audit/audit-writer.port';
import { AUDIT_REPOSITORY } from './application/ports';
import { AuditActivityReader } from './infrastructure/audit-activity.reader';
import { ChainedAuditWriter } from './infrastructure/chained-audit.writer';
import { PrismaAuditRepository } from './infrastructure/prisma-audit.repository';

/**
 * Audit — What happened, when, by whom — provably?
 *
 * **Owns:** AuditEvent, the hash chain, evidence export
 * **Depends on:** — (written by every module through the audit port)
 *
 * `AUDIT_WRITER` — it owns the chain, so it owns the only way to append to it. The port is
 * declared in `core/` because every module writes to it; the binding is here because only
 * this module knows how the chain is maintained. Global, for the same reason: audit is a
 * cross-cutting obligation, not a dependency a module should have to remember to import.
 *
 * Phase 1 implements the write path — the chain, the per-tenant sequence, and the advisory
 * lock that keeps both single-threaded per tenant. Reading the trail, verifying it on a
 * schedule and exporting evidence bundles belong to Phase 9, which owns that capability; the
 * `AuditService` interface in `application/ports.ts` is deliberately still unbound.
 */
@Global()
@Module({
  providers: [
    { provide: AUDIT_REPOSITORY, useClass: PrismaAuditRepository },
    { provide: AUDIT_WRITER, useClass: ChainedAuditWriter },
    // Activity is a view of the trail, not a second log — see core/activity/activity.port.ts.
    { provide: ACTIVITY_READER, useClass: AuditActivityReader },
  ],
  exports: [AUDIT_WRITER, AUDIT_REPOSITORY, ACTIVITY_READER],
})
export class AuditModule {}
