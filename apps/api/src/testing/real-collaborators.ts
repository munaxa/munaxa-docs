import type { ClockPort } from '../ports/clock.port';
import { AdministeredWriter } from '../core/persistence/administered-writer';
import { RecordStamps } from '../core/persistence/record-stamps';
import { PrismaOutboxWriter } from '../core/outbox/prisma-outbox.writer';
import type { UnitOfWork } from '../core/prisma/unit-of-work';
import { ChainedAuditWriter } from '../modules/audit/infrastructure/chained-audit.writer';
import { PrismaAuditRepository } from '../modules/audit/infrastructure/prisma-audit.repository';

/**
 * Real collaborators, wired the way the container wires them.
 *
 * This exists for one reason, and it is a boundary reason rather than a convenience one. An
 * integration test for the organisation module needs the **real** audit writer, because half of what
 * it is asserting is that the audit event and the change commit together — and a double cannot be
 * wrong about that, since it is written from the same belief as the code it stands in for. But a test
 * living under `src/modules/organization/` may not import `src/modules/audit/infrastructure/`: that
 * is the cross-module boundary `eslint.config.mjs` enforces, and it enforces it for tests too,
 * correctly, because a test that reaches into another module's internals is a test that will keep
 * passing after that module's contract changes.
 *
 * So the composition lives here, outside `src/modules/`, which is the layer whose *job* is to know
 * how the pieces fit together. `tsconfig.build.json` excludes this directory, so nothing here can be
 * reached from production code by accident.
 *
 * The alternative — building each test through `Test.createTestingModule(AppModule)` — is what
 * `auth.e2e.integration.spec.ts` does and is right for an end-to-end test of the HTTP surface. For a
 * test about one service's transactional behaviour it would mean booting Redis, the token verifier
 * and every provider in the application to assert something about two tables.
 */

/**
 * The audit writer the application binds: append-only, hash-chained, joins the caller's
 * transaction.
 */
export function realAuditWriter(clock: ClockPort, unitOfWork: UnitOfWork): ChainedAuditWriter {
  return new ChainedAuditWriter(new PrismaAuditRepository(), clock, unitOfWork);
}

/**
 * Everything an administered service needs to write: the transaction boundary, the audit trail, the
 * record stamps, and the outbox.
 *
 * Returned as a bundle because a test that assembled them individually would be free to assemble
 * them differently from the container — and then it would be testing a composition nothing ships.
 */
export function realWriteStack(
  clock: ClockPort,
  unitOfWork: UnitOfWork,
): {
  readonly stamps: RecordStamps;
  readonly audit: ChainedAuditWriter;
  readonly outbox: PrismaOutboxWriter;
  readonly writer: AdministeredWriter;
} {
  const stamps = new RecordStamps(clock);
  const audit = realAuditWriter(clock, unitOfWork);
  return {
    stamps,
    audit,
    outbox: new PrismaOutboxWriter(stamps),
    writer: new AdministeredWriter(unitOfWork, audit, stamps),
  };
}
