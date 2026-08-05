import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DocumentId,
  type LegalHoldId,
  asId,
} from '@edms/domain';
import { squish } from '@edms/utils';

import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { RetentionAudit } from '../domain/audit-actions';
import { legalHoldPlacedEvent, legalHoldReleasedEvent } from '../domain/events';
import {
  LEGAL_HOLD_REPOSITORY,
  type LegalHoldRecord,
  type LegalHoldRepository,
  type LegalHoldService,
  RETENTION_SCHEDULE_REPOSITORY,
  type RetentionScheduleRepository,
} from './ports';

/**
 * A legal hold: the one thing in the product that refuses regardless of permission.
 *
 * Three properties are worth reading before the code, because each is a decision rather than an
 * implementation detail.
 *
 * **A hold suspends the schedule rather than deleting it.** Placing a hold moves every live
 * schedule to `SUSPENDED`; releasing the *last* one moves them back to `PENDING`. The alternative —
 * checking for a hold at disposition time and leaving the schedule alone — would work, and it would
 * make the recycle bin and the disposition queue silently wrong: a document would appear "due for
 * purge on Tuesday" for as long as the matter ran. The state is on the row so that every reader
 * sees the same answer.
 *
 * **Several holds may sit on one document, and releasing one releases one.** Two unrelated matters
 * legitimately hold the same record, and a release that lifted both would be a release that
 * destroyed evidence for a matter nobody mentioned. The disposition resumes only when the last live
 * hold goes.
 *
 * **This service knows nothing about documents.** It takes an identifier, writes a row and audits
 * it — no read of `document`, no call into Document's service. That is what keeps the dependency
 * one-way: Document injects this to ask "is it held", and if this asked Document anything back the
 * two would be a cycle the container could not resolve.
 */
@Injectable()
export class DefaultLegalHoldService implements LegalHoldService {
  constructor(
    @Inject(LEGAL_HOLD_REPOSITORY) private readonly holds: LegalHoldRepository,
    @Inject(RETENTION_SCHEDULE_REPOSITORY) private readonly schedules: RetentionScheduleRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  async isHeld(documentId: DocumentId): Promise<boolean> {
    const live = await this.holds.listLiveFor(documentId);
    return live.length > 0;
  }

  heldAmong(documentIds: readonly string[]): Promise<ReadonlySet<string>> {
    return this.holds.heldAmong(documentIds);
  }

  listFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]> {
    return this.writer.read(() => this.holds.listFor(documentId));
  }

  async place(documentId: string, reason: string): Promise<LegalHoldRecord> {
    const stated = this.requireReason(reason);

    return this.writer.write<LegalHoldRecord>(async () => {
      const id = this.writer.clock.nextId();
      const placedById = this.requireActor();
      const placedAt = this.writer.clock.now();

      await this.holds.place({ id, documentId, reason: stated, placedById, placedAt });
      const suspended = await this.schedules.setSuspended(asId<DocumentId>(documentId), true);

      await this.outbox.publish([
        legalHoldPlacedEvent(asId<AnyId>(id), {
          legalHoldId: id,
          documentId,
          placedBy: placedById,
          reason: stated,
        }),
      ]);

      const record = await this.require(asId<LegalHoldId>(id));
      return {
        result: record,
        change: {
          action: RetentionAudit.HOLD_PLACED,
          // Filed against the *document*, not the hold. A hold is an event in the life of a
          // record, and an auditor reading that record's timeline is the reader who needs it —
          // filing it under its own identifier would put it in a timeline nobody opens.
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(documentId),
          operation: AdministrativeOperation.CREATED,
          after: { legalHoldId: id, schedulesSuspended: suspended },
          reason: stated,
        },
      };
    });
  }

  async release(id: string, reason: string): Promise<void> {
    const stated = this.requireReason(reason);

    await this.writer.write(async () => {
      const hold = await this.require(asId<LegalHoldId>(id));
      if (hold.releasedAt !== null) {
        throw new ValidationError('That hold has already been released.', [
          { field: 'releasedAt', message: 'released' },
        ]);
      }

      const releasedBy = this.requireActor();
      const released = await this.holds.release(
        asId<LegalHoldId>(id),
        releasedBy,
        stated,
        this.writer.clock.now(),
      );
      if (!released) {
        // Somebody released it between the read and the write. Not an error to the caller — the
        // hold is off, which is what they asked for — but nothing further is theirs to do.
        throw new ValidationError('That hold has already been released.', [
          { field: 'releasedAt', message: 'released' },
        ]);
      }

      // Only when the last one goes. Two matters holding one record is ordinary, and resuming the
      // schedule while the second still runs would destroy evidence nobody released.
      const remaining = await this.holds.listLiveFor(hold.documentId);
      const resumed =
        remaining.length === 0 ? await this.schedules.setSuspended(hold.documentId, false) : 0;

      await this.outbox.publish([
        legalHoldReleasedEvent(asId<AnyId>(id), {
          legalHoldId: id,
          documentId: hold.documentId,
          releasedBy,
        }),
      ]);

      return {
        result: undefined,
        change: {
          action: RetentionAudit.HOLD_RELEASED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(hold.documentId),
          operation: AdministrativeOperation.UPDATED,
          before: { legalHoldId: id, placedAt: hold.placedAt.toISOString() },
          after: { holdsRemaining: remaining.length, schedulesResumed: resumed },
          reason: stated,
        },
      };
    });
  }

  // --- Internals ---------------------------------------------------------------------------

  private async require(id: LegalHoldId): Promise<LegalHoldRecord> {
    const hold = await this.holds.findById(id);
    if (hold === null) {
      throw new NotFoundError('The requested legal hold');
    }
    return hold;
  }

  /**
   * A hold with no stated matter is a hold nobody can ever justify releasing, and the same is true
   * of the release. The database refuses an empty one too; this is the sentence a person reads.
   */
  private requireReason(raw: string): string {
    const reason = squish(raw);
    if (reason.length === 0) {
      throw new ValidationError('A reason is required.', [
        { field: 'reason', message: 'required' },
      ]);
    }
    return reason;
  }

  private requireActor(): string {
    const { userId } = requireContext();
    if (userId === null) {
      // Placing or releasing a hold is always somebody's act. The scheduled sweep never does it,
      // and a hold attributed to the system would be a hold with nobody accountable for it.
      throw new ValidationError('A legal hold is always somebody’s act.', [
        { field: 'actor', message: 'required' },
      ]);
    }
    return userId;
  }
}
