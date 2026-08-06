import { Inject, Injectable } from '@nestjs/common';

import type { AuditActor, AuditEntry, AuditWriter } from '../../../core/audit/audit-writer.port';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
  currentTransaction,
} from '../../../core/prisma/unit-of-work';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { PlatformAuditRepository } from './platform-audit.repository';
import { createDocsAuditService, toPlatformEvent } from './platform-audit.service';

/**
 * The only way to append to the audit trail.
 *
 * Two guarantees, and the second is the one that is easy to lose:
 *
 * **The event commits with the change it describes.** `write()` joins the caller's ambient
 * transaction rather than opening one, so there is no window in which a document changed and
 * the trail does not say so. It refuses outright if there is no transaction to join, because
 * the alternative — quietly opening its own — is how a rolled-back change leaves a permanent
 * record of something that never happened.
 *
 * **The chain has no forks and no holes.** The head is read under a per-tenant advisory lock
 * taken in the same transaction, so two concurrent writers cannot compute the same
 * `previousHash`; and the sequence is allocated as `tail + 1` rather than from a PostgreSQL
 * sequence, which would gap on rollback and make a deletion indistinguishable from an
 * ordinary abort (`docs/architecture/13-audit-architecture.md` §4).
 *
 * ## What changed, and what did not
 *
 * The sealing is `@munaxa/audit`'s now: the canonical material, the digest over it, the chain
 * linkage, the sequence advance and the format stamp. What stayed is everything the Platform never
 * asked for — the advisory lock and the gap-free `tail + 1` allocation live in
 * `PlatformAuditRepository`, and the identifier strategy and the historical canonical format live
 * in `createDocsAuditService`. No digest changed: the v3 format reproduces `chainHash()` byte for
 * byte, which `platform-canonical.spec.ts` asserts against `chainHash` itself rather than a
 * fixture, because the table refuses the `UPDATE` that would rehash a row.
 */
@Injectable()
export class ChainedAuditWriter implements AuditWriter {
  constructor(
    private readonly repository: PlatformAuditRepository,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async write(actor: AuditActor, entry: AuditEntry): Promise<void> {
    if (!currentTransaction()) {
      throw new Error(
        'AuditWriter.write() must run inside the transaction it is recording. Use ' +
          'writeStandalone() for an event with nothing to commit alongside it.',
      );
    }
    await this.append(actor, entry);
  }

  /**
   * For events with nothing to commit alongside them — a failed sign-in, a denied read.
   *
   * These are exactly the events an attacker would prefer to leave none of, so they get their
   * own transaction rather than being dropped for lack of one. Joining an outer transaction
   * when one happens to exist is deliberate: the record is still written, and it is still
   * atomic with whatever else that transaction decides.
   */
  async writeStandalone(actor: AuditActor, entry: AuditEntry): Promise<void> {
    await this.unitOfWork.run(() => this.append(actor, entry));
  }

  private async append(actor: AuditActor, entry: AuditEntry): Promise<void> {
    const occurredAt = this.clock.now();
    const audit = createDocsAuditService(this.repository, occurredAt);

    // The handle is named rather than left implicit so `AuditService` knows the append joined a
    // transaction it does not own, and does not retry a chain conflict inside one that has
    // already aborted. The adapter checks it is the same transaction it is about to write in.
    await audit.write(toPlatformEvent(actor, entry, occurredAt), {
      transaction: currentTransaction(),
    });
  }
}
