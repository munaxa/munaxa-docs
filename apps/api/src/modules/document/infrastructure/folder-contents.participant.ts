import { Inject, Injectable } from '@nestjs/common';

import { type DocumentId, RetentionTrigger, asId } from '@edms/domain';

import { LegalHoldError } from '../../../core/errors/application-errors';
import { RecordStamps } from '../../../core/persistence';
import type { FolderContentsCascade } from '../../library/application/folder-contents.port';
import {
  LEGAL_HOLD_SERVICE,
  RETENTION_SCHEDULER,
  type LegalHoldService,
  type RetentionScheduler,
} from '../../retention/application/ports';
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
    return taken.length;
  }
}
