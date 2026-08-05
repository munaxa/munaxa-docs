import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DocumentId,
  RetentionScheduleState,
  RetentionTrigger,
  type RetentionTriggerKey,
  Settings,
  asId,
} from '@edms/domain';

import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { RetentionAudit } from '../domain/audit-actions';
import { retentionScheduledEvent } from '../domain/events';
import { cancelledByRestore, proposeSchedule } from '../domain/schedule';
import {
  LEGAL_HOLD_REPOSITORY,
  type LegalHoldRepository,
  RETENTION_POLICY_READER,
  RETENTION_SCHEDULE_REPOSITORY,
  type RetentionPolicyReader,
  type RetentionScheduleRepository,
  type RetentionScheduler,
} from './ports';

/**
 * The seam Document writes a schedule through, without knowing what a schedule is.
 *
 * Separate from `DefaultRetentionService` for a composition reason that is worth keeping visible:
 * this class is what *Document* depends on — its delete, restore and publication call it inside
 * their own transactions — while the sweep depends on Document to carry out a purge. Splitting the
 * two halves is what keeps the module graph acyclic without a `forwardRef`: this half sits below
 * Document, the disposition half sits above it, and neither knows the other exists.
 *
 * Everything here joins the caller's transaction. A publication that rolls back leaves no schedule
 * behind, and a delete's `SCHEDULE_SET` commits with the delete it describes or not at all.
 */
@Injectable()
export class RetentionSchedulerService implements RetentionScheduler {
  constructor(
    @Inject(RETENTION_SCHEDULE_REPOSITORY) private readonly schedules: RetentionScheduleRepository,
    @Inject(LEGAL_HOLD_REPOSITORY) private readonly holds: LegalHoldRepository,
    @Inject(RETENTION_POLICY_READER) private readonly policies: RetentionPolicyReader,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  /**
   * A trigger fired.
   *
   * The policy's terms are read *now* and copied onto the schedule row. That is the accepted half
   * of ADR-0010's alternative 3: editing a policy applies to triggers that fire later and to
   * nothing already scheduled — computing the terms again at disposition time is what was
   * rejected, because it would let a policy edit silently re-date history.
   */
  async onTrigger(input: {
    documentId: DocumentId;
    trigger: RetentionTriggerKey;
    at: Date;
    policyId: string | null;
    documentNumber: string | null;
  }): Promise<void> {
    const policy = input.policyId === null ? null : await this.policies.read(input.policyId);
    const proposal = proposeSchedule({
      trigger: input.trigger,
      at: input.at,
      policy,
      documentNumber: input.documentNumber,
      recycleBinDays: await this.settings.get(Settings.RETENTION_RECYCLE_BIN_DAYS),
    });
    if (proposal === null) {
      return;
    }

    const saved = await this.schedules.save({
      documentId: input.documentId,
      policyId: proposal.policyId,
      trigger: input.trigger,
      triggerAt: proposal.triggerAt,
      dueAt: proposal.dueAt,
      disposition: proposal.disposition,
      reviewRequired: proposal.reviewRequired,
    });

    // A document already under hold gets its new schedule suspended immediately, rather than by
    // the next hold somebody happens to place. A schedule reading `PENDING` while a matter runs
    // would make the disposition queue disagree with the refusal the sweep is about to give.
    if ((await this.holds.listLiveFor(input.documentId)).length > 0) {
      await this.schedules.setSuspended(input.documentId, true);
    }

    await this.outbox.publish([
      retentionScheduledEvent(asId<AnyId>(input.documentId), {
        documentId: input.documentId,
        dueAt: proposal.dueAt.toISOString(),
        disposition: proposal.disposition,
        // The payload shipped with `policyId: string` in Phase 0.5 and a policy-less schedule is
        // Phase 10's addition. The empty string rather than a widened shape: an event's shape
        // never changes once shipped (`domain/events.ts`).
        policyId: proposal.policyId ?? '',
      }),
    ]);

    // `SCHEDULE_SET` is its own action rather than a payload field of the delete or the
    // publication: "when did this record's clock start" is a question a records-management report
    // asks on its own (13 §2).
    await this.writer.record({
      action: RetentionAudit.SCHEDULE_SET,
      subjectType: AuditSubjectType.DOCUMENT,
      subjectId: asId<AnyId>(input.documentId),
      operation: AdministrativeOperation.CREATED,
      after: {
        scheduleId: saved.id,
        trigger: input.trigger,
        dueAt: proposal.dueAt.toISOString(),
        disposition: proposal.disposition,
        reviewRequired: proposal.reviewRequired,
        policyId: proposal.policyId,
      },
    });
  }

  /**
   * A restore withdraws what its delete created — and only that.
   *
   * The publication schedule survives, or deleting and restoring a record would be a way to reset
   * its retention period (`domain/schedule.ts`, `cancelledByRestore`).
   */
  async onRestored(documentId: DocumentId): Promise<void> {
    let withdrawn = 0;
    for (const trigger of Object.values(RetentionTrigger).filter(cancelledByRestore)) {
      withdrawn += await this.schedules.cancelForTrigger(documentId, trigger);
    }
    if (withdrawn === 0) {
      return;
    }
    await this.writer.record({
      action: RetentionAudit.SCHEDULE_SET,
      subjectType: AuditSubjectType.DOCUMENT,
      subjectId: asId<AnyId>(documentId),
      operation: AdministrativeOperation.DELETED,
      before: { trigger: RetentionTrigger.ON_DELETE, schedules: withdrawn },
      after: { state: RetentionScheduleState.CANCELLED },
    });
  }
}
