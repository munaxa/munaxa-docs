import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DocumentId,
  DocumentLockReleaseReason,
  DocumentStatus,
  type DocumentStatusKey,
  RevisionStatus,
  ScanStatus,
  Settings,
  asId,
  calendarDay,
  RetentionTrigger,
} from '@edms/domain';

import {
  ContentNotScannedError,
  DocumentLockedError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { RETENTION_SCHEDULER, type RetentionScheduler } from '../../retention/application/ports';
import { RevisionControlAudit } from '../domain/audit-actions';
import {
  documentCheckedInEvent,
  documentCheckedOutEvent,
  documentPublishedEvent,
} from '../domain/events';
import { readMetadata } from '../domain/metadata';
import type { DefaultDocumentService } from './document.service';
import {
  DOCUMENT_CONTENT_GATE,
  DOCUMENT_LOCK_REPOSITORY,
  DOCUMENT_REPOSITORY,
  DOCUMENT_SERVICE,
  type DocumentContentGate,
  type DocumentLockRepository,
  type DocumentRepository,
  type DocumentRow,
  type LockRecord,
  REVISION_WRITER,
  type RevisionWriter,
} from './ports';
import { DOCUMENT_CONFIGURATION, type DocumentConfiguration } from './configuration.port';

/**
 * Check-out, check-in, publication and restore — the operations that move a document between
 * its published revision and its next one.
 *
 * Four decisions shape this file, each taken deliberately and recorded in the Phase 6 report.
 *
 * **The lock order against the document row is fixed: the document row first, the lock row
 * second, revision rows last.** Every path that moves the document's status takes the row
 * under its optimistic version before touching `document_lock`, so two operations on one
 * document serialise on the row and cannot deadlock across the pair. The race itself is not
 * decided by that read-then-move — it is decided by `uq_document_lock_live`, a partial unique
 * index of exactly the shape of `uq_workflow_instance_live`: two check-outs racing produce one
 * lock and one refusal naming the holder, whatever both believed they had read.
 *
 * **Publication is manual, and immediate.** `06-document-lifecycle.md` §3 allows "effective
 * date reached or published manually"; this phase builds the manual half and records the
 * scheduled half as owed. The effective-from date defaults to today in the tenant's timezone
 * and may not be in the future — publishing a document that is not yet effective would need
 * the timer this phase deliberately does not build.
 *
 * **An approved, unnumbered document does not publish.** A type whose definition says
 * `assignNumber: false` produces approvals with no number, and those are legitimate — but
 * `ck_document_numbered_when_published` stands in the database and the refusal here says the
 * same thing in a sentence: assign a number (manually, under `numbering:manage`) first.
 *
 * **"Multiple file check-in" means many documents, not many files in one revision.**
 * ADR-0003 gives a revision exactly one file, and `document_revision.file_object_id` is that
 * decision in a column. The batch endpoint checks several documents in — each its own
 * transaction, each with one file — and a request that wants several files inside one revision
 * is refused with the reason stated, not silently modelled around.
 */
@Injectable()
export class RevisionControlService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_LOCK_REPOSITORY) private readonly locks: DocumentLockRepository,
    @Inject(REVISION_WRITER) private readonly revisions: RevisionWriter,
    @Inject(DOCUMENT_CONTENT_GATE) private readonly content: DocumentContentGate,
    @Inject(DOCUMENT_CONFIGURATION) private readonly configuration: DocumentConfiguration,
    @Inject(DOCUMENT_SERVICE) private readonly service: DefaultDocumentService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(RETENTION_SCHEDULER) private readonly retention: RetentionScheduler,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  /**
   * Takes the exclusive claim on producing this document's next revision.
   *
   * From `PUBLISHED`, or from `CHECKED_OUT` when the standing lock has lapsed — the takeover
   * releases the expired lock as `EXPIRED` in the same transaction, which is the only way an
   * expired lock is ever swept: there is no background job hunting for them, because a lock
   * nobody wants to take over excludes nobody.
   */
  async checkOut(id: string): Promise<DocumentRow> {
    return this.writer.write<DocumentRow>(async () => {
      const document = await this.require(id);
      const actor = this.requireActor();
      const now = this.writer.clock.now();

      let sweptFrom: string | null = null;
      if (document.status === DocumentStatus.CHECKED_OUT) {
        const swept = await this.locks.releaseExpired(asId<DocumentId>(id), now);
        if (swept === null) {
          const live = await this.locks.liveFor(asId<DocumentId>(id));
          if (live !== null && live.lockedBy === actor) {
            throw new ValidationError('You already have this document checked out.', [
              { field: 'documentId', message: 'held by you' },
            ]);
          }
          if (live !== null) {
            throw new DocumentLockedError(live.lockedBy, live.expiresAt);
          }
          // Status says CHECKED_OUT and no lock stands: a takeover committed between the read
          // and here. The insert below settles it either way.
        } else {
          sweptFrom = swept.lockedBy;
        }
      } else {
        // The document row first — this is the fixed lock order. An illegal starting state
        // (DRAFT, APPROVED, anything unpublished) is refused in here with both halves named.
        await this.service.applyLifecycleTransition({
          documentId: id,
          to: DocumentStatus.CHECKED_OUT,
          workflowInstanceId: null,
          reason: null,
        });
      }

      const expiryHours = await this.settings.get(Settings.CHECKOUT_EXPIRY_HOURS);
      const lock = await this.locks.acquire({
        id: this.writer.clock.nextId(),
        documentId: id,
        lockedBy: actor,
        checkedOutRevisionId: document.currentRevisionId,
        acquiredAt: now,
        expiresAt: new Date(now.getTime() + expiryHours * HOUR_MS),
      });

      await this.outbox.publish([
        documentCheckedOutEvent(asId<AnyId>(id), {
          documentId: id,
          lockedBy: actor,
          expiresAt: lock.expiresAt.toISOString(),
        }),
      ]);

      return {
        result: await this.require(id),
        change: {
          action: RevisionControlAudit.CHECKED_OUT,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          after: {
            lockId: lock.id,
            expiresAt: lock.expiresAt.toISOString(),
            checkedOutRevisionId: document.currentRevisionId,
            ...(sweptFrom !== null && { tookOverExpiredLockOf: sweptFrom }),
          },
        },
      };
    });
  }

  /**
   * Checks new content in: revision `n+1`, in `DRAFT`, beneath the still-effective published
   * revision — the two-machine rule of `06-document-lifecycle.md` §1 made concrete. The
   * document returns to `DRAFT` and the draft goes through submission and approval like any
   * other change; readers keep seeing the published revision throughout.
   *
   * `keepCheckedOut` records the draft on the lock and keeps the claim, which is what makes
   * the cancel row of §3 — "draft revision discarded" — reachable at all: a further check-in
   * replaces the working draft (the old one is `DISCARDED`, its ordinal spent), and a cancel
   * discards it and returns the document to `PUBLISHED` untouched.
   */
  async checkIn(input: {
    documentId: string;
    fileObjectId: string;
    filename: string;
    changeNote: string;
    keepCheckedOut: boolean;
  }): Promise<DocumentRow> {
    return this.writer.write<DocumentRow>(async () => {
      const document = await this.require(input.documentId);
      const actor = this.requireActor();
      if (document.status !== DocumentStatus.CHECKED_OUT) {
        throw new InvalidTransitionError(document.status, DocumentStatus.DRAFT);
      }
      const live = await this.requireLiveLock(input.documentId);
      if (live.lockedBy !== actor) {
        // The holder checks in; anybody else goes through force check-in, with a reason.
        throw new ForbiddenError('check in a document somebody else has checked out');
      }

      if (!input.keepCheckedOut) {
        // The document row first, per the fixed lock order.
        await this.service.applyLifecycleTransition({
          documentId: input.documentId,
          to: DocumentStatus.DRAFT,
          workflowInstanceId: null,
          reason: null,
        });
      }

      const replacedDraftId = await this.discardWorkingDraft(document, live);
      const file = await this.requireAttachable(input.fileObjectId);
      const policy = await this.configuration.documentType(document.documentTypeId);
      const revision = await this.revisions.createNext({
        documentId: input.documentId,
        fileObjectId: file.fileObjectId,
        filename: input.filename,
        changeNote: input.changeNote,
        labelStyle: policy?.revisionLabelStyle ?? '',
        restoredFromRevisionId: null,
      });
      await this.content.reference(file.fileObjectId);
      await this.documents.attachLatestRevision(
        asId<DocumentId>(input.documentId),
        revision.revisionId,
      );

      if (input.keepCheckedOut) {
        await this.locks.attachDraft(live.id, revision.revisionId);
      } else {
        await this.requireEnded(
          await this.locks.release({
            lockId: live.id,
            reason: DocumentLockReleaseReason.CHECKED_IN,
            releasedBy: actor,
            releaseNote: null,
            at: this.writer.clock.now(),
          }),
          input.documentId,
          DocumentStatus.DRAFT,
        );
      }

      await this.outbox.publish([
        documentCheckedInEvent(asId<AnyId>(input.documentId), {
          documentId: input.documentId,
          newRevisionId: revision.revisionId,
          ordinal: revision.ordinal,
        }),
      ]);

      return {
        result: await this.require(input.documentId),
        change: {
          action: RevisionControlAudit.CHECKED_IN,
          subjectType: AuditSubjectType.REVISION,
          subjectId: asId<AnyId>(revision.revisionId),
          operation: AdministrativeOperation.CREATED,
          after: {
            documentId: input.documentId,
            ordinal: revision.ordinal,
            label: revision.label,
            fileObjectId: file.fileObjectId,
            checksumSha256: file.checksumSha256,
            changeNote: input.changeNote,
            keptCheckedOut: input.keepCheckedOut,
            ...(replacedDraftId !== null && { replacedDraftRevisionId: replacedDraftId }),
          },
        },
      };
    });
  }

  /**
   * Several documents checked in as one request — what "multiple file check-in" means here.
   *
   * One transaction *per document*, not one across the lot: each check-in is a complete fact
   * on its own, and a batch where the fourth item's virus verdict fails must not roll back the
   * three documents already honestly checked in. The per-item outcome says what happened to
   * each; nothing is retried silently.
   */
  async checkInMany(
    items: readonly {
      documentId: string;
      fileObjectId: string;
      filename: string;
      changeNote: string;
    }[],
  ): Promise<readonly BatchCheckInOutcome[]> {
    const outcomes: BatchCheckInOutcome[] = [];
    for (const item of items) {
      try {
        const document = await this.checkIn({ ...item, keepCheckedOut: false });
        outcomes.push({
          documentId: item.documentId,
          ok: true,
          revisionLabel: document.latestRevision?.label ?? null,
        });
      } catch (error) {
        outcomes.push({
          documentId: item.documentId,
          ok: false,
          reason: error instanceof Error ? error.message : 'The check-in failed.',
        });
      }
    }
    return outcomes;
  }

  /**
   * Gives the claim back. The working draft, if a check-in left one on the lock, is
   * `DISCARDED` — retained in history, its ordinal spent — and its blob dereferenced; the
   * document returns to `PUBLISHED` exactly as it stood.
   */
  async cancelCheckOut(id: string): Promise<DocumentRow> {
    const actor = this.requireActor();
    return this.endCheckOut(id, {
      requireHolder: actor,
      reason: DocumentLockReleaseReason.CANCELLED,
      releaseNote: null,
      preserveDraft: false,
      action: RevisionControlAudit.CHECKOUT_CANCELLED,
    });
  }

  /**
   * Releases somebody else's lock, under `document:force-checkin`, with a reason.
   *
   * The holder's uploaded draft is preserved by default (`10-revision-architecture.md` §3):
   * the document lands in `DRAFT` with the draft as its latest revision, exactly as if the
   * holder had completed the check-in. `discardDraft` throws that work away instead — the
   * administrative cancel — and the audit event records which was done, to whom, and why.
   */
  async forceCheckIn(
    id: string,
    input: { note: string; discardDraft: boolean },
  ): Promise<DocumentRow> {
    const note = input.note.trim();
    if (note.length === 0) {
      // Taking somebody's lock away has to answer "why" — the reason is the audit trail's, not
      // a courtesy to the form.
      throw new ValidationError('A reason is required to force a check-in.', [
        { field: 'note', message: 'required' },
      ]);
    }
    return this.endCheckOut(id, {
      requireHolder: null,
      reason: DocumentLockReleaseReason.FORCED,
      releaseNote: note,
      preserveDraft: !input.discardDraft,
      action: RevisionControlAudit.CHECKOUT_FORCED,
    });
  }

  /**
   * Publishes the approved revision: `APPROVED → PUBLISHED` on the document, the revision to
   * `PUBLISHED`, the prior published revision to `SUPERSEDED`, `current_revision_id` moved —
   * one transaction, because "exactly one published revision at any time" is a fact that
   * cannot be true in halves. Under concurrency the database decides: `uq_revision_published`
   * refuses the second publish whatever it read.
   */
  async publish(
    id: string,
    input: { effectiveFrom?: string | undefined; effectiveTo?: string | undefined },
  ): Promise<DocumentRow> {
    return this.writer.write<DocumentRow>(async () => {
      const document = await this.require(id);
      if (document.status !== DocumentStatus.APPROVED) {
        throw new InvalidTransitionError(document.status, DocumentStatus.PUBLISHED);
      }
      if (document.documentNumber === null) {
        // Approved under a definition that assigns no number — legitimate, and unpublishable
        // as it stands: `ck_document_numbered_when_published` would refuse below this refusal.
        // The sentence points at the door: manual assignment, under `numbering:manage`.
        throw new ValidationError(
          'This document has no number. Assign one (Administration → Numbering, or the manual assignment on this document) before publishing.',
          [{ field: 'documentNumber', message: 'required before publication' }],
        );
      }
      if (document.latestRevisionId === null) {
        throw new NotFoundError('A revision to publish');
      }

      const timezone = await this.settings.get(Settings.TIMEZONE);
      const today = calendarDay(this.writer.clock.now(), timezone);
      const effectiveFrom = input.effectiveFrom ?? today;
      if (effectiveFrom > today) {
        // Scheduled publication needs the timer this phase deliberately does not build; a
        // future date accepted here would be a promise nothing keeps.
        throw new ValidationError(
          'Publication takes effect immediately; the effective date cannot be in the future.',
          [{ field: 'effectiveFrom', message: 'future' }],
        );
      }
      const effectiveTo = input.effectiveTo ?? null;
      if (effectiveTo !== null && effectiveTo < effectiveFrom) {
        throw new ValidationError('The effective window ends before it starts.', [
          { field: 'effectiveTo', message: 'before effectiveFrom' },
        ]);
      }

      // The document row first — the version guard here is what serialises two publishes far
      // enough for the partial unique index to referee the rest.
      await this.service.applyLifecycleTransition({
        documentId: id,
        to: DocumentStatus.PUBLISHED,
        workflowInstanceId: null,
        reason: null,
      });

      const now = this.writer.clock.now();
      const { supersededRevisionId } = await this.revisions.publish({
        documentId: id,
        revisionId: document.latestRevisionId,
        publishedAt: now,
        effectiveFrom: asDate(effectiveFrom),
        effectiveTo: effectiveTo === null ? null : asDate(effectiveTo),
        metadataSnapshot: snapshotOf(document),
      });
      await this.documents.setCurrentRevision(asId<DocumentId>(id), document.latestRevisionId);

      // Publication may start the record's retention clock: the frozen policy's ON_PUBLISH
      // trigger, evaluated now and copied onto the schedule (ADR-0010 §7). Joins this
      // transaction, so a publish that rolls back leaves no schedule behind.
      await this.retention.onTrigger({
        documentId: asId<DocumentId>(id),
        trigger: RetentionTrigger.ON_PUBLISH,
        at: now,
        policyId: document.retentionPolicyId,
        documentNumber: document.documentNumber,
      });

      await this.outbox.publish([
        documentPublishedEvent(asId<AnyId>(id), {
          documentId: id,
          revisionId: document.latestRevisionId,
          supersededRevisionId,
          effectiveFrom,
        }),
      ]);

      // The second audit event of this transaction — the superseded revision's own — is
      // recorded beneath the primary one, so "when did this stop being effective" is
      // answerable by subject rather than by reading another row's payload.
      if (supersededRevisionId !== null) {
        await this.writer.write(() =>
          Promise.resolve({
            result: undefined,
            change: {
              action: RevisionControlAudit.SUPERSEDED,
              subjectType: AuditSubjectType.REVISION,
              subjectId: asId<AnyId>(supersededRevisionId),
              operation: AdministrativeOperation.UPDATED,
              after: { documentId: id, supersededByRevisionId: document.latestRevisionId },
            },
          }),
        );
      }

      return {
        result: await this.require(id),
        change: {
          action: RevisionControlAudit.PUBLISHED,
          subjectType: AuditSubjectType.REVISION,
          subjectId: asId<AnyId>(document.latestRevisionId),
          operation: AdministrativeOperation.UPDATED,
          after: {
            documentId: id,
            documentNumber: document.documentNumber,
            effectiveFrom,
            effectiveTo,
            ...(supersededRevisionId !== null && { supersededRevisionId }),
          },
        },
      };
    });
  }

  /**
   * Restores an older revision's content as the next revision. Restore never rewinds: the old
   * revision is untouched evidence, the new one references the same blob — a row, not a copy
   * (`10-revision-architecture.md` §5, §7) — and the draft goes through approval like any
   * other change if the type requires it.
   *
   * Mechanically it is a check-out and check-in in one transaction: the same transitions, the
   * same lock discipline (a lock row is acquired and released `CHECKED_IN`, so the lock
   * history says what happened), the same refusals when somebody else holds the document.
   */
  async restoreRevision(
    id: string,
    revisionId: string,
    input: { changeNote?: string | undefined },
  ): Promise<DocumentRow> {
    return this.writer.write<DocumentRow>(async () => {
      const document = await this.require(id);
      const actor = this.requireActor();
      if (document.status !== DocumentStatus.PUBLISHED) {
        throw new InvalidTransitionError(document.status, DocumentStatus.CHECKED_OUT);
      }
      const source = await this.revisions.describe(id, revisionId);
      if (source === null) {
        throw new NotFoundError('The revision to restore');
      }
      if (source.status === RevisionStatus.PUBLISHED) {
        throw new ValidationError('That revision is already the published one.', [
          { field: 'revisionId', message: 'current' },
        ]);
      }
      const file = await this.requireAttachable(source.fileObjectId);

      // Check-out: document row, then lock — the fixed order.
      await this.service.applyLifecycleTransition({
        documentId: id,
        to: DocumentStatus.CHECKED_OUT,
        workflowInstanceId: null,
        reason: null,
      });
      const now = this.writer.clock.now();
      const expiryHours = await this.settings.get(Settings.CHECKOUT_EXPIRY_HOURS);
      const lock = await this.locks.acquire({
        id: this.writer.clock.nextId(),
        documentId: id,
        lockedBy: actor,
        checkedOutRevisionId: document.currentRevisionId,
        acquiredAt: now,
        expiresAt: new Date(now.getTime() + expiryHours * HOUR_MS),
      });

      // Check-in, carrying the old content: the same blob, referenced once more.
      const policy = await this.configuration.documentType(document.documentTypeId);
      const revision = await this.revisions.createNext({
        documentId: id,
        fileObjectId: source.fileObjectId,
        filename: source.filename,
        changeNote: input.changeNote ?? `Restored from ${source.label}`,
        labelStyle: policy?.revisionLabelStyle ?? '',
        restoredFromRevisionId: source.id,
      });
      await this.content.reference(file.fileObjectId);
      await this.documents.attachLatestRevision(asId<DocumentId>(id), revision.revisionId);
      await this.requireEnded(
        await this.locks.release({
          lockId: lock.id,
          reason: DocumentLockReleaseReason.CHECKED_IN,
          releasedBy: actor,
          releaseNote: null,
          at: now,
        }),
        id,
        DocumentStatus.DRAFT,
      );
      await this.service.applyLifecycleTransition({
        documentId: id,
        to: DocumentStatus.DRAFT,
        workflowInstanceId: null,
        reason: null,
      });

      await this.outbox.publish([
        documentCheckedInEvent(asId<AnyId>(id), {
          documentId: id,
          newRevisionId: revision.revisionId,
          ordinal: revision.ordinal,
        }),
      ]);

      return {
        result: await this.require(id),
        change: {
          action: RevisionControlAudit.RESTORED_FROM,
          subjectType: AuditSubjectType.REVISION,
          subjectId: asId<AnyId>(revision.revisionId),
          operation: AdministrativeOperation.CREATED,
          after: {
            documentId: id,
            restoredFromRevisionId: source.id,
            restoredFromLabel: source.label,
            ordinal: revision.ordinal,
            label: revision.label,
            fileObjectId: source.fileObjectId,
          },
        },
      };
    });
  }

  /**
   * A signed link to one revision's content — history as evidence, not only as a list. The
   * confidentiality level's own download rule applies exactly as it does to the current
   * content: a level that forbids download forbids it for every revision equally.
   */
  async revisionDownloadUrl(
    id: string,
    revisionId: string,
    inline: boolean,
  ): Promise<{ url: string; expiresAt: Date }> {
    return this.writer.read(async () => {
      const document = await this.require(id);
      const revision = await this.revisions.describe(id, revisionId);
      if (revision === null) {
        throw new NotFoundError('The requested revision');
      }
      const level = await this.configuration.confidentiality(document.confidentialityId);
      if (level !== null && !level.allowDownload) {
        throw new ForbiddenError('download this document');
      }
      return this.content.downloadUrl(revision.fileObjectId, revision.filename, { inline });
    });
  }

  // --- Internals -------------------------------------------------------------------------

  /** The shared ending of cancel and force: transition, draft disposition, release, audit. */
  private async endCheckOut(
    id: string,
    options: {
      requireHolder: string | null;
      reason: (typeof DocumentLockReleaseReason)[keyof typeof DocumentLockReleaseReason];
      releaseNote: string | null;
      preserveDraft: boolean;
      action: string;
    },
  ): Promise<DocumentRow> {
    return this.writer.write<DocumentRow>(async () => {
      const document = await this.require(id);
      if (document.status !== DocumentStatus.CHECKED_OUT) {
        throw new InvalidTransitionError(document.status, DocumentStatus.PUBLISHED);
      }
      const live = await this.requireLiveLock(id);
      if (options.requireHolder !== null && live.lockedBy !== options.requireHolder) {
        throw new ForbiddenError('cancel a check-out somebody else holds');
      }

      const draftPreserved = options.preserveDraft && live.draftRevisionId !== null;

      // The document row first. With a preserved draft the document lands in DRAFT — exactly
      // as if the holder had completed the check-in — otherwise back to PUBLISHED untouched.
      await this.service.applyLifecycleTransition({
        documentId: id,
        to: draftPreserved ? DocumentStatus.DRAFT : DocumentStatus.PUBLISHED,
        workflowInstanceId: null,
        reason: options.releaseNote,
      });

      let discardedDraftId: string | null = null;
      if (!draftPreserved) {
        discardedDraftId = await this.discardWorkingDraft(document, live);
      }

      await this.requireEnded(
        await this.locks.release({
          lockId: live.id,
          reason: options.reason,
          releasedBy: this.requireActor(),
          releaseNote: options.releaseNote,
          at: this.writer.clock.now(),
        }),
        id,
        DocumentStatus.PUBLISHED,
      );

      return {
        result: await this.require(id),
        change: {
          action: options.action,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          after: {
            lockId: live.id,
            holder: live.lockedBy,
            ...(options.releaseNote !== null && { note: options.releaseNote }),
            ...(discardedDraftId !== null && { discardedDraftRevisionId: discardedDraftId }),
            ...(draftPreserved && { draftPreservedAsLatest: live.draftRevisionId }),
          },
        },
      };
    });
  }

  /**
   * Discards the lock's working draft, if one stands: `DISCARDED`, its blob dereferenced, the
   * document's latest revision pointed back at the published one. The row stays — the ordinal
   * is spent, and history says what became of it.
   */
  private async discardWorkingDraft(
    document: DocumentRow,
    lock: LockRecord,
  ): Promise<string | null> {
    if (lock.draftRevisionId === null) {
      return null;
    }
    const draft = await this.revisions.describe(document.id, lock.draftRevisionId);
    if (draft === null || draft.status !== RevisionStatus.DRAFT) {
      return null;
    }
    await this.revisions.discard({ documentId: document.id, revisionId: draft.id });
    await this.content.dereference(draft.fileObjectId);
    if (document.currentRevisionId !== null) {
      await this.documents.attachLatestRevision(
        asId<DocumentId>(document.id),
        document.currentRevisionId,
      );
    }
    await this.locks.attachDraft(lock.id, null);
    return draft.id;
  }

  /**
   * Refuses when the check-out was already ended underneath this transaction — Slice 49.
   *
   * `applyLifecycleTransition` is idempotent when the document already holds the status being
   * asked for, and that is deliberate: a workflow stage activating twice must not be a conflict.
   * It is also the hole a second cancel fell through. Two administrators cancelling one check-out
   * both read it as live, the winner moved the document to `PUBLISHED`, and the loser's transition
   * found the document already there and returned without touching the version — so nothing
   * refused it, and it went on to file a second `CHECKOUT_CANCELLED` for a check-out that had
   * been cancelled once.
   *
   * The lock is the thing that says a check-out is live, so the lock's own affected-row count is
   * the truth. Thrown rather than swallowed, and thrown here rather than earlier, because the
   * whole operation is one transaction: the refusal rolls back the transition, the discarded
   * draft and the audit row together. The status is re-read so the error names what the document
   * actually holds, which makes it the same refusal the sequential second caller already gets.
   */
  private async requireEnded(
    ended: boolean,
    documentId: string,
    to: DocumentStatusKey,
  ): Promise<void> {
    if (ended) {
      return;
    }
    const current = await this.require(documentId);
    throw new InvalidTransitionError(current.status, to);
  }

  private async requireLiveLock(documentId: string): Promise<LockRecord> {
    const live = await this.locks.liveFor(asId<DocumentId>(documentId));
    if (live === null) {
      // CHECKED_OUT with no live lock cannot be produced by this code; refusing loudly is how
      // a repair script's half-done state gets found rather than worked around.
      throw new ValidationError('This document is marked checked out but no lock stands.', [
        { field: 'documentId', message: 'no live lock' },
      ]);
    }
    return live;
  }

  private async requireAttachable(fileObjectId: string): Promise<AttachableFileFacts> {
    const file = await this.content.describe(fileObjectId);
    if (file === null) {
      throw new ValidationError('That upload could not be found.', [
        { field: 'fileObjectId', message: 'unknown' },
      ]);
    }
    if (file.scanStatus !== ScanStatus.CLEAN) {
      // The same gate as creation, for the same reason, with the same database trigger below
      // it: a revision may not reference a blob that is not CLEAN.
      throw new ContentNotScannedError(file.scanStatus);
    }
    return file;
  }

  private async require(id: string): Promise<DocumentRow> {
    const row = await this.documents.findById(asId<DocumentId>(id), false);
    if (row === null) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private requireActor(): string {
    const { userId } = requireContext();
    if (userId === null) {
      throw new ForbiddenError('perform revision control without a signed-in user');
    }
    return userId;
  }
}

export interface BatchCheckInOutcome {
  readonly documentId: string;
  readonly ok: boolean;
  readonly revisionLabel?: string | null;
  readonly reason?: string;
}

interface AttachableFileFacts {
  readonly fileObjectId: string;
  readonly checksumSha256: string;
  readonly scanStatus: string;
}

/** What the approver saw: every tenant-defined field's value at the instant of publication. */
function snapshotOf(document: DocumentRow): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  for (const entry of document.metadata) {
    snapshot[entry.key] = {
      name: entry.name,
      dataType: entry.dataType,
      value: readMetadata(entry.dataType, entry.columns),
    };
  }
  return snapshot;
}

/** A calendar day as the `date` column's midnight-UTC instant. */
function asDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const HOUR_MS = 3_600_000;
