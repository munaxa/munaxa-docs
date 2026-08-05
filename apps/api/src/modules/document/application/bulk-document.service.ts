import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  BulkOperationKind,
  type DocumentId,
  DocumentOrigin,
  Permission,
  ScopeType,
  type ScopeRef,
  asId,
  normaliseTargets,
} from '@edms/domain';

import {
  BULK_EXECUTOR,
  type BulkExecutor,
  type BulkPlan,
  type BulkResult,
} from '../../../core/bulk';
import { ValidationError } from '../../../core/errors/application-errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import type { MetadataInputValue } from '../domain/metadata';
import { DOCUMENT_REPOSITORY, type DocumentRepository } from './ports';
// A value import: a type-only one erases the `design:paramtypes` metadata Nest resolves by.
import { DefaultDocumentService } from './document.service';

/**
 * Bulk metadata, bulk restore and bulk upload — Document's three of the five.
 *
 * ## What this class deliberately is not
 *
 * It is not a second implementation of anything. Every `apply` below is a call to
 * `DefaultDocumentService`'s own single-object use case, so a bulk restore reverses exactly one
 * cascade because `restore` does, a bulk metadata edit refuses a frozen document because `update`
 * does, and `ErrorCode.LEGAL_HOLD` refuses regardless of permission because Phase 10 put it in the
 * delete path and nothing here reaches around it. The executor turns each of those refusals into a
 * `BLOCKED` row and carries on with the rest of the batch.
 *
 * That is the whole design, and it is worth being explicit about the alternative it rejects. The
 * fast implementation of a bulk metadata edit is one `UPDATE … WHERE id IN (…)`, which is between
 * one and two orders of magnitude quicker and skips: the reach check per object, the frozen-status
 * check, the optimistic-lock check, the per-document audit row, the outbox event, and the search
 * re-projection. Six correctness properties traded for latency on an operation nobody watches.
 *
 * ## Reach is resolved at the document, per document
 *
 * `resolveScope` answers a `DOCUMENT` scope ref, which is what `AclGuard` would have bound through
 * `@ScopedTo('id', ScopeType.DOCUMENT)` on the single-object route. It answers `null` for an
 * identifier that resolves to nothing *in this tenant's live rows* — and the executor turns that
 * into `REFUSED` rather than `NOT_FOUND`, because "this identifier does not exist" and "you cannot
 * see it" must be the same answer or the endpoint becomes a probe.
 *
 * The one asymmetry is restore, and it is deliberate: a deleted document has to be *findable* to
 * be restorable, so `resolveScope` for a restore looks through the soft delete. It does not look
 * through the ACL — the reach check that follows is the same one, on the same scope, and Phase 14's
 * resolver does not care whether the row is deleted. A caller who could not see the document before
 * it was deleted cannot restore it.
 */
@Injectable()
export class BulkDocumentService {
  constructor(
    @Inject(BULK_EXECUTOR) private readonly executor: BulkExecutor,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    private readonly service: DefaultDocumentService,
  ) {}

  /**
   * The same metadata change, applied to many documents.
   *
   * **No `If-Match`, and confidentiality may not be changed here.** Those two facts are the same
   * fact. `update` demands a version when the confidentiality level moves, because that change
   * alters who may see the document and losing a concurrent edit to it is a disclosure — and a
   * bulk request cannot carry N versions, so there is no honest way to satisfy it. Rather than
   * quietly passing `undefined` and letting `requireVersion` throw for every document, the change
   * is refused at the door with a reason a person can read. Every other field is an ordinary edit
   * where last-writer-wins is the documented behaviour of the single-object path too.
   */
  async setMetadata(input: {
    readonly ids: readonly string[];
    readonly categoryId?: string | null | undefined;
    readonly metadata?: Readonly<Record<string, MetadataInputValue>> | undefined;
  }): Promise<BulkResult> {
    if (input.categoryId === undefined && input.metadata === undefined) {
      throw new ValidationError('A bulk metadata edit must change something.', [
        { field: 'metadata', message: 'required' },
      ]);
    }
    const plan: BulkPlan = {
      kind: BulkOperationKind.METADATA,
      permission: Permission.DOCUMENT_EDIT,
      parameters: {
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.metadata !== undefined && { metadataFields: Object.keys(input.metadata) }),
      },
      resolveScope: (id) => this.liveDocumentScope(id),
      apply: async (id) => {
        await this.service.update(
          id,
          {
            ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
            ...(input.metadata !== undefined && { metadata: input.metadata }),
          },
          undefined,
        );
      },
    };
    return this.executor.run({ plan, targetIds: normaliseTargets(input.ids) });
  }

  /**
   * Many documents out of the recycle bin, each reversing exactly one delete.
   *
   * `document:restore` per object, which is also the permission Phase 15 made the deleted-documents
   * report require — so the set of documents somebody can see in the bin is the set they can select
   * here, and selecting past it is refused per object rather than at the request.
   *
   * Phase 10 kept restore inside the module that owns the row precisely so each restore writes its
   * own audit event, and `DefaultRecycleBinService` "restores nothing itself". This does not change
   * that: the bin is still a surface over Document's restore, and this is a second surface over the
   * same one.
   */
  async restore(ids: readonly string[]): Promise<BulkResult> {
    const plan: BulkPlan = {
      kind: BulkOperationKind.RESTORE,
      permission: Permission.DOCUMENT_RESTORE,
      parameters: {},
      resolveScope: (id) => this.anyDocumentScope(id),
      apply: async (id) => {
        await this.service.restore(id, undefined);
      },
    };
    return this.executor.run({ plan, targetIds: normaliseTargets(ids) });
  }

  /**
   * Many already-uploaded files become many documents in one folder.
   *
   * **The one bulk operation that is not N permission decisions, and the record says so.** The
   * objects being created do not exist yet, so there is nothing to resolve reach *at*: the decision
   * is `document:create` on the destination folder, taken once, because that is the same decision
   * the single-object create takes. Every target identifier is a `file_object`, and the scope
   * resolved for each is the folder — so the executor's per-object loop still runs the check, and
   * still refuses every object if the folder is out of reach, but the answer is the same N times
   * and pretending otherwise would be theatre.
   *
   * The bytes are already in storage: Phase 3's upload session moved them, one at a time, through
   * the antivirus gate. This creates the controlled records over them, which is why an import of
   * five thousand files is five thousand transactions rather than five thousand transfers — and why
   * content addressing means five thousand copies of one form are one blob (ADR-0007), with no code
   * here doing anything to obtain that.
   */
  async upload(input: {
    readonly folderId: string;
    readonly documentTypeId: string;
    readonly files: readonly {
      readonly fileObjectId: string;
      readonly filename: string;
      readonly title: string;
    }[];
    readonly categoryId?: string | null | undefined;
    readonly confidentialityId?: string | undefined;
  }): Promise<BulkResult> {
    const byFileObject = new Map(input.files.map((file) => [file.fileObjectId, file]));
    const folderScope: ScopeRef = { type: ScopeType.FOLDER, id: asId<AnyId>(input.folderId) };

    const plan: BulkPlan = {
      kind: BulkOperationKind.UPLOAD,
      permission: Permission.DOCUMENT_CREATE,
      parameters: {
        folderId: input.folderId,
        documentTypeId: input.documentTypeId,
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.confidentialityId !== undefined && {
          confidentialityId: input.confidentialityId,
        }),
      },
      resolveScope: (fileObjectId) =>
        Promise.resolve(byFileObject.has(fileObjectId) ? folderScope : null),
      apply: async (fileObjectId) => {
        const file = byFileObject.get(fileObjectId);
        if (file === undefined) {
          throw new ValidationError('This file was not part of the request.', [
            { field: 'fileObjectId', message: 'unknown' },
          ]);
        }
        await this.service.create({
          folderId: input.folderId,
          documentTypeId: input.documentTypeId,
          categoryId: input.categoryId ?? null,
          ...(input.confidentialityId !== undefined && {
            confidentialityId: input.confidentialityId,
          }),
          title: file.title,
          fileObjectId: file.fileObjectId,
          filename: file.filename,
          origin: DocumentOrigin.UPLOAD,
          // A bulk import is exactly the case where duplicates are expected and are the *point*:
          // five thousand scanned forms will contain repeats, and refusing the batch on the first
          // one would make the feature unusable. The duplicate is still one blob, and the
          // duplicates endpoint still finds them all afterwards.
          acknowledgeDuplicate: true,
        });
      },
    };
    return this.executor.run({
      plan,
      targetIds: normaliseTargets(input.files.map((file) => file.fileObjectId)),
    });
  }

  /** A document's scope, if it is live and in this tenant. Null means "you do not reach it". */
  private async liveDocumentScope(id: string): Promise<ScopeRef | null> {
    return this.documentScope(id, false);
  }

  /** The same, looking through the soft delete — what a restore has to be able to find. */
  private async anyDocumentScope(id: string): Promise<ScopeRef | null> {
    return this.documentScope(id, true);
  }

  private async documentScope(id: string, includeDeleted: boolean): Promise<ScopeRef | null> {
    const row = await this.unitOfWork.run(() =>
      this.documents.findById(asId<DocumentId>(id), includeDeleted),
    );
    return row === null ? null : { type: ScopeType.DOCUMENT, id: asId<AnyId>(row.id) };
  }
}
