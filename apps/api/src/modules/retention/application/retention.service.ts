import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DocumentId,
  RetentionScheduleState,
  Settings,
  asId,
} from '@edms/domain';
import { type Page, type PageRequest, squish } from '@edms/utils';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { RetentionAudit } from '../domain/audit-actions';
import { documentPurgedEvent, retentionDueEvent } from '../domain/events';
import {
  DispositionOutcome,
  type DispositionOutcomeKey,
  addDays,
  decideDisposition,
} from '../domain/schedule';
import {
  BLOB_REAPER,
  type BlobReaper,
  DOCUMENT_EXPIRY,
  type DocumentExpiry,
  type DocumentExpirySweep,
  type IntegritySweep,
  DOCUMENT_DISPOSITION,
  type DocumentDisposition,
  LEGAL_HOLD_REPOSITORY,
  type LegalHoldRepository,
  RETENTION_SCHEDULE_REPOSITORY,
  type RetentionScheduleRecord,
  type RetentionScheduleRepository,
  type RetentionService,
  type SweepOutcome,
  TOMBSTONE_REPOSITORY,
  type TombstoneRecord,
  type TombstoneRepository,
} from './ports';

/**
 * Retention's execution half: the sweep, the disposition review, and the purge.
 *
 * ADR-0010 is the design and this is where it becomes true. Four things in it are decisions rather
 * than mechanism, and each is worth reading before the code.
 *
 * **Nothing is destroyed by a user action, and there is no "purge now".** Every removal in this
 * file starts from a `retention_schedule` row whose date has arrived. The only manual step is
 * *approving* a disposition the policy already scheduled, which is ADR-0010's alternative 2
 * rejected in the design and rejected again here — an administrator's purge button is exactly the
 * mechanism by which records under an unnoticed hold get destroyed.
 *
 * **The purge writes before it removes.** The tombstone and both audit events are written inside
 * the same transaction as the removal, *from facts read before anything went*. The order matters
 * because of what makes this phase's risk real: `audit_event` refuses `DELETE` to every role, so
 * the trail survives whatever this code does — and a trail whose subject is gone is only legible
 * if the number went somewhere the purge does not reach. If the transaction rolls back, the
 * tombstone rolls back with it, and nothing claims a destruction that did not happen.
 *
 * **A hold is checked twice, and the second time is the one that counts.** `decideDisposition`
 * refuses a held schedule, and the purge re-reads the holds inside its own transaction. The first
 * check keeps the sweep's counts honest; the second makes the refusal a property of the database
 * rather than of the interval between two statements.
 *
 * **The sweep is idempotent under redelivery.** `retention.run` has concurrency 1 — "destruction
 * is never run concurrently with itself" — but at-least-once delivery still means the same nightly
 * job can arrive twice. A purge removes the schedule with the document inside one transaction, so
 * a redelivered sweep re-reads `listDue`, finds nothing live, and does nothing.
 */
@Injectable()
export class DefaultRetentionService implements RetentionService {
  constructor(
    @Inject(RETENTION_SCHEDULE_REPOSITORY) private readonly schedules: RetentionScheduleRepository,
    @Inject(LEGAL_HOLD_REPOSITORY) private readonly holds: LegalHoldRepository,
    @Inject(TOMBSTONE_REPOSITORY) private readonly tombstones: TombstoneRepository,
    @Inject(DOCUMENT_DISPOSITION) private readonly documents: DocumentDisposition,
    @Inject(BLOB_REAPER) private readonly blobs: BlobReaper,
    @Inject(DOCUMENT_EXPIRY) private readonly documentExpiry: DocumentExpiry,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly writer: AdministeredWriter,
  ) {}

  // --- Reading ------------------------------------------------------------------------------

  scheduleFor(documentId: DocumentId): Promise<readonly RetentionScheduleRecord[]> {
    return this.writer.read(() => this.schedules.findForDocument(documentId));
  }

  listTombstones(request: PageRequest): Promise<Page<TombstoneRecord>> {
    return this.writer.read(() => this.tombstones.list(request));
  }

  /** The dispositions somebody has to look at: due now, or waiting on a reviewer. */
  listDue(limit: number): Promise<readonly RetentionScheduleRecord[]> {
    return this.writer.read(() => this.schedules.listDue(this.writer.clock.now(), limit));
  }

  // --- The sweep ----------------------------------------------------------------------------

  /**
   * One pass of `retention.sweep`.
   *
   * Each schedule is settled in its **own** transaction rather than the whole batch in one. A pass
   * bounded by the lane's fifteen-minute budget that failed on schedule ninety-seven would
   * otherwise roll back ninety-six purges — and every one of them had already earned its tombstone
   * and its audit rows, which the trail cannot take back.
   */
  async executeDue(limit: number): Promise<SweepOutcome> {
    const now = this.writer.clock.now();
    const due = await this.writer.read(() => this.schedules.listDue(now, limit));

    let reviewed = 0;
    let purged = 0;
    let archived = 0;
    let blocked = 0;

    for (const schedule of due) {
      const outcome = await this.settle(schedule);
      switch (outcome) {
        case DispositionOutcome.PURGE:
          purged += 1;
          break;
        case DispositionOutcome.ARCHIVE:
          archived += 1;
          break;
        case DispositionOutcome.BLOCKED:
          blocked += 1;
          break;
        default:
          reviewed += 1;
      }
    }

    const blobsReclaimed = await this.reclaimBlobs(limit);
    const outcome = { reviewed, purged, archived, blocked, blobsReclaimed };
    // Reported rather than only returned: a sweep that found nothing and a sweep that refused
    // ninety-seven documents both return without throwing, and the counts are the difference.
    this.logger.info('Retention sweep completed', { ...outcome });
    return outcome;
  }

  /**
   * A person confirms a disposition. The only manual step ADR-0010 allows.
   *
   * It destroys nothing itself. It moves the schedule to `IN_REVIEW` with a reviewer on it, and
   * the *next* sweep executes it — which keeps destruction on the single-consumer lane the queue
   * catalogue describes ("destruction is never run concurrently with itself") rather than on
   * whichever web request happened to carry the approval.
   */
  async approveDisposition(scheduleId: string, note: string): Promise<void> {
    const stated = squish(note);
    if (stated.length === 0) {
      throw new ValidationError('A note is required.', [{ field: 'note', message: 'required' }]);
    }

    await this.writer.write(async () => {
      const schedule = await this.requireSchedule(scheduleId);
      if (schedule.state !== RetentionScheduleState.PENDING) {
        throw new ValidationError('That disposition is not awaiting approval.', [
          { field: 'state', message: schedule.state },
        ]);
      }
      if ((await this.holds.listLiveFor(schedule.documentId)).length > 0) {
        throw new ValidationError('That document is under legal hold.', [
          { field: 'legalHold', message: 'held' },
        ]);
      }

      await this.schedules.moveState({
        id: schedule.id,
        state: RetentionScheduleState.IN_REVIEW,
        reviewedById: this.requireActor(),
        reviewedAt: this.writer.clock.now(),
        reviewNote: stated,
      });

      return {
        result: undefined,
        change: {
          action: RetentionAudit.DISPOSITION_APPROVED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(schedule.documentId),
          operation: AdministrativeOperation.UPDATED,
          before: { state: schedule.state },
          after: {
            scheduleId: schedule.id,
            state: RetentionScheduleState.IN_REVIEW,
            disposition: schedule.disposition,
          },
          reason: stated,
        },
      };
    });
  }

  /**
   * Blobs nothing references any more, past the grace period.
   *
   * `StorageService.listUnreferenced` has carried "only retention calls this, and only at a
   * reference count of zero" since Phase 3 and had no caller until now. The grace period is why
   * this is not simply "delete at zero": a delete and the restore that undoes it are separated by
   * however long somebody takes to notice, and a restore whose bytes were reclaimed an hour
   * earlier would put back a row pointing at nothing.
   */
  async reclaimBlobs(limit: number): Promise<number> {
    const graceDays = await this.settings.get(Settings.RETENTION_BLOB_GRACE_DAYS);
    const before = addDays(this.writer.clock.now(), -graceDays);
    const candidates = await this.writer.read(() => this.blobs.listReclaimable(before, limit));

    let reclaimed = 0;
    for (const blob of candidates) {
      // One transaction each, and the reference count re-checked inside it. A revision created
      // between the listing and the delete would have taken the count back off zero, and removing
      // the object then is how a live document loses its content.
      if (await this.blobs.reclaim(blob.id)) {
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  /** `storage.sweep-upload-sessions`, the second schedule this lane carries. */
  expireUploadSessions(): Promise<number> {
    return this.blobs.expireUploadSessions(this.writer.clock.now());
  }

  /**
   * `storage.verify-integrity`, the third — Phase 18.
   *
   * A pass-through, deliberately. Everything about what a checksum means, what quarantine does and
   * which finding is an incident belongs to Storage; what belongs here is only that this lane's
   * third schedule fired, which is the same division `expireUploadSessions` above has.
   */
  verifyStoredIntegrity(): Promise<IntegritySweep> {
    return this.blobs.verifyStoredIntegrity();
  }

  /**
   * `documents.expire-effective` — Phase 6.1, and a pass-through exactly like the one above it.
   *
   * Nothing about expiry is decided here, and that is the point of the line being this short: the
   * boundary arithmetic, the tenant timezone, the transaction per document and the `EXPIRED` audit
   * row are all Document's, reached through `DOCUMENT_EXPIRY`. This class is on the path only
   * because it is the service the lane's single consumer already holds.
   */
  expireEffectiveDocuments(limit: number): Promise<DocumentExpirySweep> {
    return this.documentExpiry.expireEffective(limit);
  }

  // --- Internals ----------------------------------------------------------------------------

  private async settle(schedule: RetentionScheduleRecord): Promise<DispositionOutcomeKey> {
    const held = await this.writer.read(
      async () => (await this.holds.listLiveFor(schedule.documentId)).length > 0,
    );
    const outcome = decideDisposition({
      disposition: schedule.disposition,
      state: schedule.state,
      reviewRequired: schedule.reviewRequired,
      held,
    });

    switch (outcome) {
      case DispositionOutcome.BLOCKED:
        await this.block(schedule);
        return outcome;
      case DispositionOutcome.REVIEW:
        await this.raiseForReview(schedule);
        return outcome;
      case DispositionOutcome.ARCHIVE:
        await this.archive(schedule);
        return outcome;
      case DispositionOutcome.PURGE:
        await this.purge(schedule);
        return outcome;
      default:
        return DispositionOutcome.REVIEW;
    }
  }

  /**
   * A held schedule is suspended rather than skipped.
   *
   * Skipping would mean the sweep meets it again every night and refuses again every night, and
   * the disposition queue would show a document as due for years. `SUSPENDED` is a state the
   * release moves back out of, so the record's own row says why nothing is happening.
   */
  private async block(schedule: RetentionScheduleRecord): Promise<void> {
    if (schedule.state === RetentionScheduleState.SUSPENDED) {
      return;
    }
    await this.writer.write(async () => {
      await this.schedules.moveState({
        id: schedule.id,
        state: RetentionScheduleState.SUSPENDED,
      });
      return {
        result: undefined,
        change: {
          action: RetentionAudit.PURGE_EXECUTED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(schedule.documentId),
          operation: AdministrativeOperation.UPDATED,
          before: { state: schedule.state },
          after: {
            scheduleId: schedule.id,
            outcome: DispositionOutcome.BLOCKED,
            state: RetentionScheduleState.SUSPENDED,
          },
        },
      };
    });
  }

  /**
   * The schedule is due and a person has to confirm.
   *
   * Nothing moves state here: the schedule stays `PENDING` until somebody approves it, which is
   * what `approveDisposition` is for. What is published is `retention.due` — the fact Phase 12's
   * reminder will be delivered from. Nothing consumes it yet, and the outbox row is the record
   * until something does: the Phase 4 position for `workflow.*`, Phase 9's for
   * `audit.chain-broken`.
   */
  private async raiseForReview(schedule: RetentionScheduleRecord): Promise<void> {
    await this.writer.write(async () => {
      await this.outbox.publish([
        retentionDueEvent(asId<AnyId>(schedule.documentId), {
          documentId: schedule.documentId,
          dueAt: schedule.dueAt.toISOString(),
          reviewRequired: true,
        }),
      ]);
      return {
        result: undefined,
        change: {
          action: RetentionAudit.SCHEDULE_SET,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(schedule.documentId),
          operation: AdministrativeOperation.UPDATED,
          after: {
            scheduleId: schedule.id,
            dueAt: schedule.dueAt.toISOString(),
            awaitingReview: true,
          },
        },
      };
    });
  }

  private async archive(schedule: RetentionScheduleRecord): Promise<void> {
    await this.writer.write(async () => {
      // The second hold check, inside the transaction that would archive — the one `purge` has
      // taken since it was written, for exactly the same reason and now for the same disposition.
      // `settle` read the holds in a transaction that has since committed, and a matter opened in
      // the interval is committed and invisible to a decision already taken. Asking again here
      // makes the refusal a property of the database rather than of the gap between two
      // statements.
      //
      // It matters more than the reversibility of an archive suggests. `SUSPENDED` is one of
      // `LIVE_STATES`, so the `EXECUTED` below would be written straight over the suspension the
      // hold had just recorded — and a release then finds nothing suspended to resume, leaving the
      // schedule terminal and the hold with nothing left to hold.
      const live = await this.holds.listLiveFor(schedule.documentId);
      if (live.length > 0) {
        // Nothing moves the schedule here, and `purge`'s twin of this branch moves it only
        // belt-and-braces: placing a hold suspends every live schedule the document has, so a
        // document this branch can see a hold for is already `SUSPENDED`. What this returns is the
        // record that the sweep met one and stood down.
        return {
          result: undefined,
          change: {
            action: RetentionAudit.PURGE_EXECUTED,
            subjectType: AuditSubjectType.DOCUMENT,
            subjectId: asId<AnyId>(schedule.documentId),
            operation: AdministrativeOperation.UPDATED,
            after: {
              scheduleId: schedule.id,
              outcome: DispositionOutcome.BLOCKED,
              holds: live.length,
            },
          },
        };
      }

      const archived = await this.documents.archive(schedule.documentId);
      if (archived) {
        await this.schedules.moveState({
          id: schedule.id,
          state: RetentionScheduleState.EXECUTED,
          executedAt: this.writer.clock.now(),
        });
      }
      // Not archived: the lifecycle refused — a record still moving through approval reached its
      // date. The schedule stays live and the next sweep asks again; closing it would claim a
      // disposition that never ran.
      return {
        result: undefined,
        change: {
          action: RetentionAudit.PURGE_EXECUTED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(schedule.documentId),
          operation: AdministrativeOperation.UPDATED,
          after: { scheduleId: schedule.id, outcome: DispositionOutcome.ARCHIVE, archived },
        },
      };
    });
  }

  /**
   * Destruction. The one path in the product that removes rows.
   *
   * Read the order rather than the statements. Everything the trail will need is read *first*,
   * while the document still exists; the rows go; the tombstone is written from what was read; and
   * the two audit events are written last, from facts already in hand. All of it is one
   * transaction, so there is no instant at which the destruction is observable and its evidence is
   * not.
   */
  private async purge(schedule: RetentionScheduleRecord): Promise<void> {
    await this.writer.write(async () => {
      const subject = await this.documents.describe(schedule.documentId);
      if (subject === null) {
        // Already gone — the schedule outlived its document, which one crashed half-purge could
        // produce. Closed rather than retried: there is nothing left to destroy.
        await this.schedules.deleteForDocument(schedule.documentId);
        return {
          result: undefined,
          change: {
            action: RetentionAudit.PURGE_EXECUTED,
            subjectType: AuditSubjectType.DOCUMENT,
            subjectId: asId<AnyId>(schedule.documentId),
            operation: AdministrativeOperation.UPDATED,
            after: { scheduleId: schedule.id, alreadyPurged: true },
          },
        };
      }

      /*
       * The second *schedule* check, for the reason the second hold check exists — Slice 73.
       *
       * `executeDue` reads its batch in one transaction and settles each schedule in another, so
       * the record this method was handed describes a moment that has passed. A restore taken in
       * that interval cancels the schedule the delete wrote (`RetentionScheduler.onRestored`), and
       * nothing here noticed: `describe` selects the document without a `deleted_at` predicate, and
       * `deleteForDocument` removes every schedule the document has whatever state it is in, so its
       * count cannot report the withdrawal either. The sweep destroyed a document somebody had just
       * taken back out of the recycle bin, and a purge is the one act that cannot be undone.
       *
       * The state is the predicate rather than the document's `deleted_at`, and that distinction is
       * load-bearing: a restore cancels only the triggers `cancelledByRestore` names, so a published
       * record keeps the schedule its publication started and is destroyed at its disposition date
       * while perfectly live. Refusing on `deleted_at` would refuse that legitimate purge. What the
       * sweep is entitled to act on is what its own selection asked for — `dueScheduleWhere`'s
       * `PENDING` or `IN_REVIEW` — re-read here, inside the transaction that would destroy.
       */
      const current = await this.schedules.findById(schedule.id);
      if (
        current === null ||
        (current.state !== RetentionScheduleState.PENDING &&
          current.state !== RetentionScheduleState.IN_REVIEW)
      ) {
        return {
          result: undefined,
          change: {
            action: RetentionAudit.PURGE_EXECUTED,
            subjectType: AuditSubjectType.DOCUMENT,
            subjectId: asId<AnyId>(schedule.documentId),
            operation: AdministrativeOperation.UPDATED,
            after: {
              scheduleId: schedule.id,
              // Withdrawn under the sweep — the schedule it read is no longer one it may execute.
              withdrawn: current?.state ?? null,
            },
          },
        };
      }

      // The second hold check, inside the transaction that would destroy. The first kept the
      // sweep's counts honest; this one makes the refusal a property of the database rather than
      // of the interval between two statements.
      const live = await this.holds.listLiveFor(schedule.documentId);
      if (live.length > 0) {
        await this.schedules.moveState({
          id: schedule.id,
          state: RetentionScheduleState.SUSPENDED,
        });
        return {
          result: undefined,
          change: {
            action: RetentionAudit.PURGE_EXECUTED,
            subjectType: AuditSubjectType.DOCUMENT,
            subjectId: asId<AnyId>(schedule.documentId),
            operation: AdministrativeOperation.UPDATED,
            after: {
              scheduleId: schedule.id,
              outcome: DispositionOutcome.BLOCKED,
              holds: live.length,
            },
          },
        };
      }

      // This module's own rows go *first*, and the order is the foreign keys': a schedule or a
      // hold still pointing at the document would refuse its removal. Their work is done — the
      // tombstone and the two audit rows below are the evidence from here on, and a released
      // hold's history is already in the immutable trail.
      await this.schedules.deleteForDocument(schedule.documentId);
      await this.holds.deleteForDocument(schedule.documentId);

      const outcome = await this.documents.purge(schedule.documentId);
      const purgedAt = this.writer.clock.now();

      await this.tombstones.write({
        documentId: subject.documentId,
        documentNumber: subject.documentNumber,
        title: subject.title,
        documentTypeId: subject.documentTypeId,
        documentTypeName: subject.documentTypeName,
        folderPath: subject.folderPath,
        deletedAt: subject.deletedAt,
        purgedAt,
        // Null when the scheduled sweep acted, which is the normal case: executing a disposition
        // is the system carrying out a policy, not somebody's act. The approver is recorded
        // separately, because approving a disposition and executing it are different acts.
        purgedById: requireContext().userId,
        scheduleId: schedule.id,
        policyId: schedule.policyId,
        approvedById: schedule.reviewedById,
        revisionsRemoved: outcome.revisionsRemoved,
        blobsDereferenced: outcome.blobsDereferenced,
      });

      await this.outbox.publish([
        documentPurgedEvent(asId<AnyId>(schedule.documentId), {
          documentId: schedule.documentId,
          documentNumber: subject.documentNumber,
          blobsDeleted: outcome.blobsDereferenced,
        }),
      ]);

      // The document's own last event, with the number in its payload — what makes this one row
      // legible on its own once the tombstone and the reservation are the only other places the
      // number exists.
      await this.writer.record({
        action: RetentionAudit.PURGED,
        subjectType: AuditSubjectType.DOCUMENT,
        subjectId: asId<AnyId>(schedule.documentId),
        operation: AdministrativeOperation.DELETED,
        before: {
          title: subject.title,
          documentNumber: subject.documentNumber,
          documentType: subject.documentTypeName,
          folderPath: subject.folderPath,
        },
        after: { purgedAt: purgedAt.toISOString() },
      });

      return {
        result: undefined,
        change: {
          action: RetentionAudit.PURGE_EXECUTED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(schedule.documentId),
          operation: AdministrativeOperation.DELETED,
          after: {
            scheduleId: schedule.id,
            policyId: schedule.policyId,
            approvedById: schedule.reviewedById,
            documentNumber: subject.documentNumber,
            revisionsRemoved: outcome.revisionsRemoved,
            blobsDereferenced: outcome.blobsDereferenced,
          },
          ...(schedule.reviewNote !== null && { reason: schedule.reviewNote }),
        },
      };
    });
  }

  private async requireSchedule(id: string): Promise<RetentionScheduleRecord> {
    const schedule = await this.schedules.findById(id);
    if (schedule === null) {
      throw new NotFoundError('The requested disposition');
    }
    return schedule;
  }

  private requireActor(): string {
    const { userId } = requireContext();
    if (userId === null) {
      throw new ValidationError('Approving a disposition is always somebody’s act.', [
        { field: 'actor', message: 'required' },
      ]);
    }
    return userId;
  }
}
