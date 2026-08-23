import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, type DocumentId, RetentionTrigger, asId } from '@edms/domain';

import { ForbiddenError, LegalHoldError } from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { RecordStamps } from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { FolderContentsCascade } from '../../library/application/folder-contents.port';
import {
  LEGAL_HOLD_SERVICE,
  RETENTION_SCHEDULER,
  type LegalHoldService,
  type RetentionScheduler,
} from '../../retention/application/ports';
import { documentDeletedEvent, documentRestoredEvent } from '../domain/events';
import {
  DOCUMENT_CONTENT_GATE,
  DOCUMENT_REPOSITORY,
  type DocumentContentGate,
  type DocumentRepository,
  REVISION_WRITER,
  type RevisionWriter,
} from '../application/ports';

/**
 * The document half of a folder's delete cascade — Document's own code, called by Library's use
 * case through the registry, inside Library's transaction.
 *
 * The same rules as a document's own delete, because it *is* a document delete with a different
 * trigger: the hold refuses first and refuses everything, each revision's reference is given back,
 * and each unnumbered draft gets its recycle-bin schedule. What differs is the reason — the folder
 * delete is the reason, recorded on the folder's audit event, and the shared cascade identifier is
 * what ties each row to it.
 */
@Injectable()
export class DocumentFolderContentsParticipant implements FolderContentsCascade {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(REVISION_WRITER) private readonly revisions: RevisionWriter,
    @Inject(DOCUMENT_CONTENT_GATE) private readonly content: DocumentContentGate,
    @Inject(LEGAL_HOLD_SERVICE) private readonly holds: LegalHoldService,
    @Inject(RETENTION_SCHEDULER) private readonly retention: RetentionScheduler,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly stamps: RecordStamps,
  ) {}

  async deleteUnder(input: { folderId: string; path: string; cascadeId: string }): Promise<number> {
    const taken = await this.documents.cascadeDeleteUnderFolder(input);
    if (taken.length === 0) {
      return 0;
    }

    // After the stamp, before anything irreversible — the whole call is one transaction, so the
    // refusal rolls the stamps back too. Checked as a set: a subtree is one question, not one
    // query per document.
    const held = await this.holds.heldAmong(taken.map((document) => document.id));
    if (held.size > 0) {
      throw new LegalHoldError([...held][0] ?? input.folderId, held.size);
    }

    const at = this.stamps.now();
    for (const document of taken) {
      const revisions = await this.revisions.cascadeDelete(document.id, input.cascadeId);
      for (const revision of revisions) {
        if (revision.referenced) {
          await this.content.dereference(revision.fileObjectId);
        }
      }
      await this.retention.onTrigger({
        documentId: asId<DocumentId>(document.id),
        trigger: RetentionTrigger.ON_DELETE,
        at,
        policyId: document.retentionPolicyId,
        documentNumber: document.documentNumber,
      });
    }

    /*
     * The same event a document's own delete publishes — Slice 40.
     *
     * "The same rules as a document's own delete, because it *is* a document delete with a
     * different trigger" is this class's own sentence, and it was true of everything above and of
     * nothing below. `DocumentService.delete` ends with `documentDeletedEvent`; this path ended
     * with the retention call, so the search index was never told that a subtree of documents had
     * gone. `PrismaSearchSourceReader.factsFor` states the invariant it breaks: "Soft-deleted and
     * purged documents are not findable: the entry is removed, never filtered at query time — an
     * unfindable row in the index is a leak waiting for a predicate bug." Removal is what nothing
     * asked for, so the rows stayed, and a caller who could read the document before the folder
     * was deleted went on finding its title and its body text in search — while the recycle bin
     * holding it is gated on `document:restore`.
     *
     * It looked covered because it usually was: `retention.scheduled` also routes to the search
     * lane and resolves to the same document. But `proposeSchedule` returns null — and publishes
     * nothing — for a numbered document with no `ON_DELETE` policy, which is the ordinary
     * controlled record. The coverage was incidental and inverted: the documents that mattered
     * most were the ones that missed it.
     *
     * One event per document, as the single-document path emits one. The loop above already does
     * per-document work, so nothing here changes the shape of the cascade's cost.
     */
    await this.outbox.publish(
      taken.map((document) =>
        documentDeletedEvent(asId<AnyId>(document.id), {
          documentId: document.id,
          deletedBy: this.actor(),
          cascadeId: input.cascadeId,
          previousStatus: document.status,
        }),
      ),
    );
    return taken.length;
  }

  async restoreCascade(cascadeId: string): Promise<number> {
    const taken = await this.documents.listCascade(cascadeId);
    if (taken.length === 0) {
      return 0;
    }
    await this.documents.restoreCascade(cascadeId);
    for (const document of taken) {
      const revisions = await this.revisions.restoreCascade(document.id, cascadeId);
      for (const revision of revisions) {
        if (revision.referenced) {
          await this.content.reference(revision.fileObjectId);
        }
      }
      await this.retention.onRestored(asId<DocumentId>(document.id));
    }

    // And the other direction, for the same reason: a restored document that nothing re-projected
    // would stay out of the index it was removed from, unfindable until some later edit put it
    // back. `onRestored` publishes nothing at all, so this path had no incidental cover either.
    await this.outbox.publish(
      taken.map((document) =>
        documentRestoredEvent(asId<AnyId>(document.id), {
          documentId: document.id,
          restoredTo: document.status,
          renamedTo: null,
        }),
      ),
    );
    return taken.length;
  }

  /**
   * Who is doing this. A folder delete is somebody's act — `LibraryAdminService` is reached through
   * an administered write — so a null actor here is a bug rather than a case, exactly as it is on
   * `DocumentService`'s own delete.
   */
  private actor(): string {
    const { userId } = requireContext();
    if (userId === null) {
      throw new ForbiddenError('delete a folder without a signed-in user');
    }
    return userId;
  }
}
