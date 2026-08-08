import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  DocumentStatus,
  type DocumentId,
  RevisionStatus,
  asId,
} from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  AdministeredWriter,
  AdministrativeOperation,
  RecordStamps,
} from '../../../core/persistence';
import type {
  DispositionSubject,
  DocumentDisposition,
  PurgeOutcome,
} from '../../retention/application/ports';
import { DocumentAudit } from '../domain/audit-actions';
import { isLegalTransition } from '../domain/lifecycle';
import { DOCUMENT_CONTENT_GATE, type DocumentContentGate } from '../application/ports';

/**
 * The purge: what `DOCUMENT_DELETION_RULES` says a disposition removes, performed as one
 * transaction, by the module that owns the aggregate being destroyed.
 *
 * ## The one deliberate ownership exception
 *
 * Two statements below touch tables Document does not own — `workflow_instance` (Workflow's) and
 * `number_reservation` (Administration's) — and that is a documented exception to the rule that a
 * module never reaches into another's rows, made for the same reason the recycle bin's read is:
 * the cascade must be **one transaction over eleven relations owned by five modules**, its order
 * is dictated by the foreign keys, and a purge that committed halfway would be rows destroyed with
 * no tombstone to say so. A port per owning module — each with exactly one caller, each running
 * exactly one statement — would put the cascade's order in no module at all, which is how the
 * product got three local answers to "what does deleting this reach" in the first place. The
 * contract is `DOCUMENT_DELETION_RULES` in `@edms/domain`, this file is held to it by the
 * integration suite, and a relation added without a row in that table is a review conversation.
 *
 * ## What is deliberately absent
 *
 * No statement here touches `audit_event` — it would raise if one tried, and that refusal is the
 * design (13 §6). No statement touches `retention_schedule` or `legal_hold`: those are Retention's
 * own, and the caller removes them beside its tombstone. And nothing deletes `number_reservation`
 * rows: the number stays spent forever, so the purge severs the pointers and leaves the value.
 */
@Injectable()
export class RetentionDispositionAdapter implements DocumentDisposition {
  constructor(
    @Inject(DOCUMENT_CONTENT_GATE) private readonly content: DocumentContentGate,
    private readonly stamps: RecordStamps,
    private readonly writer: AdministeredWriter,
  ) {}

  async describe(documentId: DocumentId): Promise<DispositionSubject | null> {
    const row = await requireTransaction().document.findFirst({
      where: { id: documentId, tenantId: this.tenantId() },
      select: {
        id: true,
        title: true,
        documentNumber: true,
        status: true,
        deletedAt: true,
        retentionPolicyId: true,
        documentType: { select: { id: true, name: true } },
        folder: { select: { path: true } },
      },
    });
    if (row === null) {
      return null;
    }
    return {
      documentId: asId<DocumentId>(row.id),
      title: row.title,
      documentNumber: row.documentNumber,
      documentTypeId: row.documentType.id,
      documentTypeName: row.documentType.name,
      folderPath: row.folder.path,
      status: row.status,
      deletedAt: row.deletedAt,
      retentionPolicyId: row.retentionPolicyId,
    };
  }

  /**
   * Removes the document and everything the table says a purge removes.
   *
   * The order is the foreign keys' order, and every dereference happens before the row holding the
   * reference goes — a row deleted first would take its reference with it, and the blob would
   * never reach zero.
   */
  async purge(documentId: DocumentId): Promise<PurgeOutcome> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();

    // 1. Give back what the rows still hold. A revision holds a reference unless it was
    //    DISCARDED (which gave its back) or soft-deleted (the delete cascade gave its back);
    //    every preview artefact holds one on its derived blob.
    const revisions = await tx.documentRevision.findMany({
      where: { tenantId, documentId },
      select: { id: true, fileObjectId: true, status: true, deletedAt: true },
    });
    const revisionIds = revisions.map((revision) => revision.id);

    let blobsDereferenced = 0;
    for (const revision of revisions) {
      if (revision.status !== RevisionStatus.DISCARDED && revision.deletedAt === null) {
        await this.content.dereference(revision.fileObjectId);
        blobsDereferenced += 1;
      }
    }
    const artifacts = await tx.previewArtifact.findMany({
      where: { tenantId, revisionId: { in: revisionIds } },
      select: { fileObjectId: true },
    });
    for (const artifact of artifacts) {
      await this.content.dereference(artifact.fileObjectId);
      blobsDereferenced += 1;
    }

    // 2. Sever the pointers that would otherwise refuse the deletes: the document's revision
    //    pointers, the restore lineage inside the revision set, and the escalation lineage inside
    //    the approval tasks (both RESTRICT, both internal to the set being removed — RESTRICT is
    //    checked per row, so a set that references itself must be unlinked before it goes).
    await tx.document.updateMany({
      where: { id: documentId, tenantId },
      data: { currentRevisionId: null, latestRevisionId: null },
    });
    await tx.documentRevision.updateMany({
      where: { tenantId, documentId },
      data: { restoredFromRevisionId: null },
    });
    await tx.approvalTask.updateMany({
      where: { tenantId, instance: { documentId } },
      data: { escalatedFromId: null },
    });

    // 3. The number stays spent; the pointers to what it was spent on go. The reservation and the
    //    tombstone are what still tie the value to what it named (`number_reservation` is one of
    //    the two relations `DOCUMENT_DELETION_RULES` retains).
    await tx.numberReservation.updateMany({
      // By document *or* by any of its approvals: a reservation drawn at submission may carry
      // only the instance, and a row still pointing at one would refuse the instance's delete.
      where: { tenantId, OR: [{ documentId }, { workflowInstance: { documentId } }] },
      data: { documentId: null, workflowInstanceId: null },
    });

    // 4. The operational rows, children before parents. The approval evidence is the audit trail,
    //    which nothing here can touch; these are stage names, comments and timers of a record the
    //    policy said to destroy.
    await tx.documentLock.deleteMany({ where: { tenantId, documentId } });
    await tx.workflowInstance.deleteMany({ where: { tenantId, documentId } });
    const removed = await tx.documentRevision.deleteMany({ where: { tenantId, documentId } });

    // 5. The root, last. Metadata values, favourites and views cascade from it at the key.
    await tx.document.deleteMany({ where: { id: documentId, tenantId } });

    return { revisionsRemoved: removed.count, blobsDereferenced };
  }

  /**
   * The non-destructive disposition: the record leaves the live shelf, readable still.
   *
   * Three things here are decisions rather than mechanism.
   *
   * **It writes the same `ARCHIVED` action the explicit path writes — Phase 6.1.** Until then this
   * method moved the status and recorded only `PURGE_EXECUTED`, in Retention's disposition
   * register, so a document retired by a policy had *nothing* on its own timeline saying it had
   * left the shelf. That is the `PURGED`/`PURGE_EXECUTED` split (13 §2, two groups, two audiences)
   * applied to the other disposition, and it is what makes "when did this record leave the shelf"
   * one query against one action rather than a question whose answer depends on which path
   * retired it. `via` in the payload carries the difference, because *which path* is a different
   * question and 13 §2's rule is that an operation belongs in the payload rather than in a second
   * action.
   *
   * The row is written with `writer.record`, the primitive Phase 10 added for exactly this: a
   * second audit event inside the unit of work already running, so it commits with the status move
   * or not at all.
   *
   * **A soft-deleted document's effective state is `DELETED`, whatever its status column says.**
   * A delete sets `deleted_at`; it does not move `status`, because the status records where the
   * record was in its *lifecycle* and a restore returns it there. So the legality of the move is
   * asked of `DELETED` for a deleted row — and `06-document-lifecycle.md`'s table already allows
   * `DELETED → ARCHIVED`, which is exactly this disposition.
   *
   * **Archiving does not undo the delete.** The row stays deleted. A disposition decides what
   * happens to the record, not whether somebody's delete was right; un-deleting as a side effect
   * of a retention period would put a document back in the live library that nobody asked to
   * restore.
   */
  async archive(documentId: DocumentId): Promise<boolean> {
    const tx = requireTransaction();
    const row = await tx.document.findFirst({
      where: { id: documentId, tenantId: this.tenantId() },
      select: { status: true, deletedAt: true },
    });
    if (row === null || row.status === DocumentStatus.ARCHIVED) {
      // Gone, or already where the disposition wanted it. Either way the schedule is done.
      return true;
    }
    const from = row.deletedAt === null ? row.status : DocumentStatus.DELETED;
    if (!isLegalTransition(from, DocumentStatus.ARCHIVED)) {
      // A live document mid-approval reached its date: lifecycle says no. The schedule stays live
      // and the next sweep asks again, which is the honest behaviour for a record still moving.
      return false;
    }
    await tx.document.updateMany({
      where: { id: documentId, tenantId: this.tenantId() },
      data: { status: DocumentStatus.ARCHIVED, ...this.stamps.update() },
    });
    await this.writer.record({
      action: DocumentAudit.DOCUMENT_ARCHIVED,
      subjectType: AuditSubjectType.DOCUMENT,
      subjectId: asId<AnyId>(documentId),
      operation: AdministrativeOperation.UPDATED,
      before: { status: from },
      after: { status: DocumentStatus.ARCHIVED, via: 'RETENTION' },
    });
    return true;
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}
