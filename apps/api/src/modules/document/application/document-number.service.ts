import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type DocumentId,
  type DocumentTypeId,
  DocumentStatus,
  NumberOrigin,
  ScopeType,
  type WorkflowInstanceId,
  asId,
} from '@edms/domain';

import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter } from '../../../core/persistence';
import {
  NUMBERING_SERVICE,
  type NumberingCodes,
  type NumberingService,
} from '../../administration/application/ports';
import {
  ORGANIZATION_SERVICE,
  type OrganizationService,
} from '../../organization/application/ports';
import { numberAssignedEvent } from '../domain/events';
import { DOCUMENT_REPOSITORY, type DocumentRepository, type DocumentRow } from './ports';
import type { DocumentNumberService } from './ports';
import { DOCUMENT_CONFIGURATION, type DocumentConfiguration } from './configuration.port';
import { DOCUMENT_PLACEMENT, type DocumentPlacement } from './placement.port';

/**
 * The document's side of numbering: which codes are true of this document, and the one write
 * onto `document.document_number`.
 *
 * The codes go to Administration's issuance service, which owns the rules, the counters and the
 * reservations; what stays here is everything that is a fact about the *document* — its library's
 * place in the scope tree, its department's branch, its type and category — resolved through the
 * same services the approval context already resolves against, and never from anything a client
 * sends (`09-numbering-architecture.md` §2).
 *
 * Everything except the manual path joins the engine's transaction: the engine already holds the
 * instance row, `assignNumber` takes the document row, and the sequence counter inside the
 * issuance service comes last. That order is fixed across every path, which is why two approvals
 * in one series contend on the counter and cannot deadlock across it.
 */
@Injectable()
export class DefaultDocumentNumberService implements DocumentNumberService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_CONFIGURATION) private readonly configuration: DocumentConfiguration,
    @Inject(DOCUMENT_PLACEMENT) private readonly placement: DocumentPlacement,
    @Inject(ORGANIZATION_SERVICE) private readonly organization: OrganizationService,
    @Inject(NUMBERING_SERVICE) private readonly numbering: NumberingService,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  async reserveForSubmission(
    documentId: DocumentId,
    workflowInstanceId: string,
  ): Promise<{ pendingNumber: string | null }> {
    const document = await this.require(documentId);
    if (document.documentNumber !== null) {
      // The revision cycle, which Phase 6 made reachable: a numbered document re-entering
      // approval is its next revision being approved, and the number identifies the document,
      // never the revision (`09-numbering-architecture.md` §4). Nothing to reserve — the
      // reference reviewers hold is the number itself.
      return { pendingNumber: null };
    }
    const policy = await this.numbering.policyFor(asId<DocumentTypeId>(document.documentTypeId));
    if (policy === null || !policy.reserveOnSubmit) {
      // Draw-at-approval — the tenant's choice, and gapless mode's definition (§2).
      return { pendingNumber: null };
    }
    const issued = await this.numbering.reserve({
      numberingRuleId: policy.numberingRuleId,
      codes: await this.codesFor(document),
      documentId,
      workflowInstanceId: asId<WorkflowInstanceId>(workflowInstanceId),
    });
    return { pendingNumber: issued.formatted };
  }

  async assignAtApproval(
    documentId: DocumentId,
    workflowInstanceId: string,
  ): Promise<{ documentNumber: string }> {
    const document = await this.require(documentId);
    if (document.documentNumber !== null) {
      // The next revision of a numbered document completing its approval. The number was
      // assigned once, at the first approval, and `QMS-…-0042` stays identical through
      // Original → R1 → R2 (§4) — so the approval completes carrying the number it already
      // has, and no counter moves.
      return { documentNumber: document.documentNumber };
    }
    const instanceId = asId<WorkflowInstanceId>(workflowInstanceId);

    // The reservation drawn at submission, if the rule reserved one — kept exactly as rendered,
    // December text and December series even when approval lands in January (§2). Otherwise the
    // draw happens now, in the same transaction as the approval, which is the reserve-then-commit
    // path with no time between the two.
    let issued = await this.numbering.reservationForInstance(instanceId);
    if (issued === null) {
      const policy = await this.numbering.policyFor(asId<DocumentTypeId>(document.documentTypeId));
      if (policy === null) {
        throw new NotFoundError('The numbering rule for this document');
      }
      issued = await this.numbering.reserve({
        numberingRuleId: policy.numberingRuleId,
        codes: await this.codesFor(document),
        documentId,
        workflowInstanceId: instanceId,
      });
    }
    const documentNumber = await this.numbering.commit(issued.reservationId, documentId);

    await this.writeNumber(document, documentNumber, issued.numberingRuleId, issued.sequenceValue);
    return { documentNumber };
  }

  async voidReservation(
    _documentId: DocumentId,
    workflowInstanceId: string,
    reason: string,
  ): Promise<void> {
    const reservation = await this.numbering.reservationForInstance(
      asId<WorkflowInstanceId>(workflowInstanceId),
    );
    if (reservation === null) {
      // Nothing was reserved — a draw-at-approval rule, or a type with no rule. Not an error:
      // every ending path calls this, and most approvals end without ever holding a value.
      return;
    }
    await this.numbering.release(reservation.reservationId, reason);
  }

  pendingNumberFor(documentId: DocumentId): Promise<string | null> {
    return this.numbering.pendingForDocument(documentId);
  }

  /**
   * A controller records a number by hand — a legacy identifier arriving with a migrated
   * document, or a number for a document approved before numbering existed (§3).
   *
   * Refused while the document is in approval: the workflow owns numbering then, and a manual
   * number racing an assignment would give the approval's reservation nothing to attach to.
   * A number that collides is refused by the issuance service and, beneath it, by the same
   * unique constraints that protect the automatic path.
   */
  async assignManually(documentId: DocumentId, requested: string): Promise<string> {
    // The one entry point with no ambient transaction — the engine paths join the approval's.
    // `read` here is only the unit of work; the audit event is the issuance service's
    // `NUMBER_ASSIGNED`, written inside this same transaction.
    return this.writer.read(() => this.assignManuallyWithin(documentId, requested));
  }

  private async assignManuallyWithin(documentId: DocumentId, requested: string): Promise<string> {
    const document = await this.require(documentId);
    if (document.documentNumber !== null) {
      throw new ValidationError('This document already holds its number, forever.', [
        { field: 'documentNumber', message: document.documentNumber },
      ]);
    }
    if (
      document.status === DocumentStatus.SUBMITTED ||
      document.status === DocumentStatus.UNDER_REVIEW
    ) {
      throw new ValidationError('A document in approval is numbered by its approval.', [
        { field: 'status', message: document.status },
      ]);
    }

    const policy = await this.numbering.policyFor(asId<DocumentTypeId>(document.documentTypeId));
    if (policy === null) {
      throw new NotFoundError('The numbering rule for this document');
    }
    const issued = await this.numbering.assignManual({
      numberingRuleId: policy.numberingRuleId,
      codes: await this.codesFor(document),
      documentId,
      requested,
      // `IMPORTED` is reserved for the bulk-import path a later phase builds; a person typing a
      // number into the product is a manual assignment whatever the number's age.
      origin: NumberOrigin.MANUAL,
    });

    await this.writeNumber(
      document,
      issued.formatted,
      issued.numberingRuleId,
      issued.sequenceValue,
    );
    return issued.formatted;
  }

  // --- Internals ---------------------------------------------------------------------------

  private async writeNumber(
    document: DocumentRow,
    documentNumber: string,
    numberingRuleId: string,
    sequenceValue: bigint,
  ): Promise<void> {
    const written = await this.documents.assignNumber(
      document.id,
      documentNumber,
      this.writer.clock.now(),
    );
    if (!written) {
      // The WHERE saw a number already present. Unreachable through the product's own paths — a
      // numbered document cannot re-enter approval and the manual path checks first — so this is
      // the write-once rule catching whatever got here anyway.
      throw new ValidationError('This document already holds its number, forever.', [
        { field: 'documentNumber', message: 'assigned' },
      ]);
    }
    await this.outbox.publish([
      numberAssignedEvent(asId<AnyId>(document.id), {
        documentId: document.id,
        documentNumber,
        numberingRuleId,
        sequenceValue: sequenceValue.toString(),
      }),
    ]);
  }

  /**
   * The document's own codes, resolved the way the approval context resolves participants:
   * entity and department from the library's scope chain, branch through the department, type
   * and category from configuration. A node the document does not sit under is simply absent,
   * and the rule's own segments decide whether that matters.
   */
  private async codesFor(document: DocumentRow): Promise<NumberingCodes> {
    const [policy, category, folder] = await Promise.all([
      this.configuration.documentType(document.documentTypeId),
      document.categoryId === null
        ? Promise.resolve(null)
        : this.configuration.category(document.categoryId),
      this.placement.folder(document.folderId),
    ]);

    let companyCode: string | undefined;
    let entityCode: string | undefined;
    let departmentCode: string | undefined;
    let branchCode: string | undefined;

    if (folder !== null && folder.ownerScopeId !== null) {
      const chain = await this.organization.scopeChainFor(
        asId<AnyId>(folder.ownerScopeId),
        folder.ownerScopeType,
      );
      companyCode = chain.find((node) => node.type === ScopeType.COMPANY)?.code;
      entityCode = chain.find((node) => node.type === ScopeType.ENTITY)?.code;
      // The deepest department, exactly as the approval context walks it: a library owned by a
      // sub-team belongs to that team.
      const department = [...chain].reverse().find((node) => node.type === ScopeType.DEPARTMENT);
      departmentCode = department?.code;
      if (department !== undefined) {
        branchCode = (await this.organization.branchCodeOf(department.id)) ?? undefined;
      }
    }

    return {
      companyCode,
      entityCode,
      branchCode,
      departmentCode,
      documentTypeCode: policy?.code,
      categoryCode: category?.code,
    };
  }

  private async require(id: DocumentId): Promise<DocumentRow> {
    const document = await this.writer.read(() => this.documents.findById(id, false));
    if (document === null) {
      throw new NotFoundError('The requested resource');
    }
    return document;
  }
}
