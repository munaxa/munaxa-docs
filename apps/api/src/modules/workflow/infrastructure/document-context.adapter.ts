import { Inject, Injectable } from '@nestjs/common';

import { type DocumentId, type DocumentStatusKey, type RevisionId, asId } from '@edms/domain';

import { DOCUMENT_SERVICE } from '../../document/application/ports';
import type { DefaultDocumentService } from '../../document/application/document.service';
import type { DocumentApprovalContext, WorkflowDocumentGate } from '../application/ports';

/**
 * What the engine needs from Document, answered by Document.
 *
 * An ordinary downward dependency rather than one of Phase 3's inversions: Workflow sits below
 * Document in the module order, so it may call it. It is still a narrow port, for the reason every
 * narrow port in this codebase exists — the engine needs to read a document's context and move its
 * status, and holding `DOCUMENT_SERVICE` directly would also let it move a document to another
 * folder or hand out a download URL.
 *
 * The mapping is the whole of this file, and it is deliberately a mapping rather than a re-export.
 * Document's `DocumentApprovalFacts` and Workflow's `DocumentApprovalContext` are two shapes that
 * happen to look alike, each owned by the module that can be wrong about it: if Document adds a
 * fact, this file is where the engine decides whether it wants it.
 */
@Injectable()
export class DocumentContextAdapter implements WorkflowDocumentGate {
  constructor(@Inject(DOCUMENT_SERVICE) private readonly documents: DefaultDocumentService) {}

  async contextFor(documentId: DocumentId): Promise<DocumentApprovalContext | null> {
    const facts = await this.documents.approvalContext(documentId);
    if (facts === null) {
      return null;
    }
    return {
      documentId: facts.documentId,
      status: facts.status,
      title: facts.title,
      documentTypeId: facts.documentTypeId,
      documentTypeName: facts.documentTypeName,
      workflowDefinitionId: facts.workflowDefinitionId,
      ownerUserId: facts.ownerUserId,
      authorUserId: facts.authorUserId,
      latestRevisionId:
        facts.latestRevisionId === null ? null : asId<RevisionId>(facts.latestRevisionId),
      latestRevisionLabel: facts.latestRevisionLabel,
      entityId: facts.entityId,
      departmentId: facts.departmentId,
      userFields: facts.userFields,
      facts: facts.facts,
    };
  }

  async transition(input: {
    readonly documentId: DocumentId;
    readonly to: DocumentStatusKey;
    readonly workflowInstanceId: string | null;
    readonly reason: string | null;
    readonly decisionComment?: string | null;
  }): Promise<void> {
    // Joins the engine's transaction — `AdministeredWriter` nests, so the status change, the
    // approval that caused it and both audit events commit together or not at all. Two audit
    // events rather than one is correct here and worth stating: the decision is a fact about the
    // task, and the transition is a fact about the document, and a compliance question asks about
    // them separately (`06-document-lifecycle.md` §5).
    await this.documents.applyLifecycleTransition({
      documentId: input.documentId,
      to: input.to,
      workflowInstanceId: input.workflowInstanceId,
      reason: input.reason,
      // Phase 6.4. Forwarded rather than dropped: this adapter is the seam between the engine's
      // port and Document's use case, and a field it does not copy is a field the use case never
      // sees however carefully both sides declare it — which is exactly how the reviewer's comment
      // arrived at `document.rejected` as the literal `REJECTED` until a test asked.
      decisionComment: input.decisionComment ?? null,
    });
  }
}
