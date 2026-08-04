import { Inject, Injectable } from '@nestjs/common';

import type { DocumentId, WorkflowInstanceId } from '@edms/domain';

import {
  DOCUMENT_NUMBER_SERVICE,
  type DocumentNumberService,
} from '../../document/application/ports';
import type { DocumentNumberAllocator } from '../application/ports';

/**
 * The binding that fills Phase 4's deliberately unbound seam.
 *
 * A remap and nothing else, like `DocumentContextAdapter` beside it: the engine speaks
 * `DOCUMENT_NUMBER_ALLOCATOR` in its own vocabulary, Document owns the one path onto
 * `document.document_number`, and this is the ordinary downward call that joins them. Every
 * method runs inside the engine's transaction, which is what ADR-0004 means by "assigned in the
 * same transaction as the approval".
 */
@Injectable()
export class DocumentNumberAllocatorAdapter implements DocumentNumberAllocator {
  constructor(@Inject(DOCUMENT_NUMBER_SERVICE) private readonly numbers: DocumentNumberService) {}

  reserveAtSubmission(input: {
    readonly documentId: DocumentId;
    readonly workflowInstanceId: WorkflowInstanceId;
  }): Promise<{ pendingNumber: string | null }> {
    return this.numbers.reserveForSubmission(input.documentId, input.workflowInstanceId);
  }

  assignAtApproval(input: {
    readonly documentId: DocumentId;
    readonly workflowInstanceId: WorkflowInstanceId;
  }): Promise<{ documentNumber: string }> {
    return this.numbers.assignAtApproval(input.documentId, input.workflowInstanceId);
  }

  voidReservation(input: {
    readonly documentId: DocumentId;
    readonly workflowInstanceId: WorkflowInstanceId;
    readonly reason: string;
  }): Promise<void> {
    return this.numbers.voidReservation(input.documentId, input.workflowInstanceId, input.reason);
  }
}
