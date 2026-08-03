import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AuditActor, AuditEntry, AuditWriter } from '../../../core/audit/audit-writer.port';
import { chainHash } from '../../../core/audit/hash-chain';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
  currentTransaction,
} from '../../../core/prisma/unit-of-work';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { AUDIT_REPOSITORY, type AuditRepository } from '../application/ports';

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
 * **The chain has no forks and no holes.** The tail is read under a per-tenant advisory lock
 * taken in the same transaction, so two concurrent writers cannot compute the same
 * `previousHash`; and the sequence is allocated as `tail + 1` rather than from a PostgreSQL
 * sequence, which would gap on rollback and make a deletion indistinguishable from an
 * ordinary abort (`docs/architecture/13-audit-architecture.md` §4).
 */
@Injectable()
export class ChainedAuditWriter implements AuditWriter {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository,
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
    const tail = await this.repository.lockAndReadTail();
    const occurredAt = this.clock.now();
    const eventId = uuidv7(occurredAt.getTime());

    const hash = chainHash(tail.hash, {
      eventId,
      tenantId: actor.tenantId,
      occurredAt,
      actorId: actor.userId,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      outcome: entry.outcome,
      payload: entry.payload,
    });

    await this.repository.append({
      id: asId<AnyId>(eventId),
      tenantId: actor.tenantId,
      sequence: tail.sequence + 1n,
      occurredAt,
      actorId: actor.userId,
      onBehalfOfId: entry.onBehalfOfId ?? null,
      channel: actor.channel,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      outcome: entry.outcome,
      payload: entry.payload,
      reason: entry.reason ?? null,
      correlationId: actor.correlationId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      hash,
      previousHash: tail.hash,
    });
  }
}
