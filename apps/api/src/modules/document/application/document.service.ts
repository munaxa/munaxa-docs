import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DocumentId,
  DocumentOrigin,
  type DocumentOriginKey,
  DocumentStatus,
  MetadataDataType,
  ScanStatus,
  type UserId,
  asId,
} from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  ContentNotScannedError,
  DuplicateError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import {
  AdministeredWriter,
  AdministrativeOperation,
  type AdministrativeOperationKey,
  checkVersion,
  requireVersion,
} from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { DocumentAudit } from '../domain/audit-actions';
import { documentCreatedEvent, documentDeletedEvent, documentMovedEvent } from '../domain/events';
import { type MetadataInputValue, coerceMetadata, referenceFieldsIn } from '../domain/metadata';
import {
  DOCUMENT_ACTIVITY_REPOSITORY,
  DOCUMENT_CONTENT_GATE,
  DOCUMENT_REPOSITORY,
  type DocumentActivityRepository,
  type DocumentContentGate,
  type DocumentListRequest,
  type DocumentRepository,
  type DocumentRow,
  type DuplicateMatchRow,
  REVISION_WRITER,
  type RecentRow,
  type RevisionWriter,
} from './ports';
import {
  DOCUMENT_CONFIGURATION,
  type DocumentConfiguration,
  type DocumentTypePolicy,
} from './configuration.port';
import { DOCUMENT_PLACEMENT, type DocumentPlacement } from './placement.port';
import { DOCUMENT_THUMBNAILER, type DocumentThumbnailer } from './thumbnail.port';

/**
 * Creating documents, describing them, and moving them about.
 *
 * The phase's shape lives here, and four decisions are worth reading before the code.
 *
 * **A document, its first revision and the reference on its blob are one transaction.** A document
 * with no revision has no content; a revision holding a blob nothing counted is a blob retention
 * will delete underneath it. Both are states no reader could interpret, so neither is observable.
 *
 * **The type's policy is copied, not referenced.** Confidentiality and retention are frozen onto
 * the document at creation, which is what lets an administrator edit a document type without
 * rewriting history — and what stops raising a type's default silently declassifying every
 * document already created under it.
 *
 * **A duplicate is a warning, not a refusal.** The same signed form filed against two projects is
 * ordinary; doing it *unknowingly* is the mistake. So the first attempt is refused with the list of
 * what it found, and an attempt that says it knows is accepted.
 *
 * **Moving is not editing.** A move changes the folder, which changes the ACL chain the document
 * resolves through, which changes who can see it. That is its own permission, its own endpoint and
 * its own audit action — never a field somebody can change by including it in a patch meant to fix
 * a title.
 */
@Injectable()
export class DefaultDocumentService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_ACTIVITY_REPOSITORY) private readonly activity: DocumentActivityRepository,
    @Inject(DOCUMENT_CONFIGURATION) private readonly configuration: DocumentConfiguration,
    @Inject(DOCUMENT_PLACEMENT) private readonly placement: DocumentPlacement,
    @Inject(DOCUMENT_CONTENT_GATE) private readonly content: DocumentContentGate,
    @Inject(REVISION_WRITER) private readonly revisions: RevisionWriter,
    @Inject(DOCUMENT_THUMBNAILER) private readonly thumbnails: DocumentThumbnailer,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  // --- Reading ---------------------------------------------------------------------------

  list(request: DocumentListRequest): Promise<Page<DocumentRow>> {
    return this.writer.read(() => this.documents.list(request));
  }

  get(id: string): Promise<DocumentRow> {
    return this.writer.read(() => this.require(id, true));
  }

  /**
   * Opens a document: returns it, remembers that this person saw it, and says so in the trail.
   *
   * Separate from `get` on purpose. A list that rendered twenty rows has not been *opened* twenty
   * times, and a "recent documents" list built from every read would be a list of whatever the
   * screen last drew. Only an explicit open counts.
   */
  async open(id: string): Promise<DocumentRow> {
    return this.writer.write<DocumentRow>(async () => {
      const document = await this.require(id, false);
      const { userId } = requireContext();
      if (userId !== null) {
        await this.activity.recordView(userId, id, this.writer.clock.now());
      }
      return {
        result: document,
        change: {
          action: DocumentAudit.DOCUMENT_VIEWED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          // The confidentiality level is in the payload because it is what decides whether this
          // event had to be written at all: levels that demand audit-on-read are the reason the
          // action exists, and a report filtering for them needs the level, not a join.
          after: {
            confidentialityId: document.confidentialityId,
            confidentialityRank: document.confidentialityRank,
          },
        },
      };
    });
  }

  listRecent(userId: UserId, request: DocumentListRequest): Promise<Page<RecentRow>> {
    return this.writer.read(() => this.activity.listRecent(userId, request));
  }

  /**
   * What else in this tenant is exactly these bytes.
   *
   * Free, because content addressing already did the work: identical files are one blob, so the
   * question is a lookup by file object rather than a comparison of anything. It is offered as its
   * own endpoint so the web client can warn *during* the upload rather than after the person has
   * filled in a form.
   */
  findDuplicates(fileObjectId: string): Promise<readonly DuplicateMatchRow[]> {
    return this.writer.read(() => this.documents.findByFileObject(fileObjectId));
  }

  // --- Writing ---------------------------------------------------------------------------

  async create(input: {
    folderId: string;
    documentTypeId: string;
    categoryId?: string | null | undefined;
    confidentialityId?: string | undefined;
    title: string;
    description?: string | undefined;
    fileObjectId: string;
    filename: string;
    metadata?: Readonly<Record<string, MetadataInputValue>> | undefined;
    origin: DocumentOriginKey;
    acknowledgeDuplicate: boolean;
  }): Promise<DocumentRow> {
    const title = this.requireTitle(input.title);

    return this.writer.write<DocumentRow>(async () => {
      const folder = await this.placement.folder(input.folderId);
      if (folder === null) {
        throw new ValidationError('That folder does not exist.', [
          { field: 'folderId', message: 'unknown' },
        ]);
      }
      const policy = await this.requireType(input.documentTypeId);
      const file = await this.requireAttachable(input.fileObjectId);

      if (!input.acknowledgeDuplicate) {
        const existing = await this.documents.findByFileObject(file.fileObjectId);
        const first = existing[0];
        if (first !== undefined) {
          // Refused once, and the refusal names what it found. "There are 3 duplicates" is not
          // something anybody can act on; "this is already filed as QA-014 under
          // Quality/Procedures" is — and the full list is one call away at the duplicates endpoint,
          // which is where a client that wants to show all of them should look.
          throw new DuplicateError('document with this exact content', 'fileObjectId', {
            documentId: first.documentId,
            title: first.title,
            folderPath: first.folderName,
            matchCount: existing.length,
          });
        }
      }

      const confidentialityId = await this.resolveConfidentiality(policy, input.confidentialityId);
      const categoryId = await this.resolveCategory(input.categoryId ?? null);
      const values = await this.resolveMetadata(policy, input.metadata ?? {});

      const id = this.writer.clock.nextId();
      await this.documents.insert({
        id,
        folderId: folder.id,
        documentTypeId: policy.id,
        categoryId,
        confidentialityId,
        // Frozen from the type, now. Editing the type later changes what the *next* document
        // inherits and nothing about this one.
        retentionPolicyId: policy.retentionPolicyId,
        title,
        description: input.description === undefined ? null : squish(input.description),
        origin: input.origin,
        ownerUserId: this.requireActor(),
      });
      await this.documents.replaceMetadata(asId<DocumentId>(id), values);

      // The first revision, and the reference on its blob. Same transaction: a document with no
      // revision has no content, and a revision holding an uncounted blob is one retention will
      // delete underneath.
      const revision = await this.revisions.createInitial({
        documentId: id,
        fileObjectId: file.fileObjectId,
        filename: input.filename,
        changeNote: null,
        labelStyle: policy.revisionLabelStyle,
      });
      await this.content.reference(file.fileObjectId);
      await this.documents.attachLatestRevision(asId<DocumentId>(id), revision.revisionId);

      // The upload-time thumbnail. Best effort by design — see `thumbnail.port.ts`. A document
      // whose creation failed because a preview could not be drawn would be a document lost to a
      // decoration.
      await this.thumbnails.generate(revision.revisionId, file.fileObjectId, file.mimeType);

      await this.outbox.publish([
        documentCreatedEvent(asId<AnyId>(id), {
          documentId: id,
          folderId: folder.id,
          documentTypeId: policy.id,
          ownerUserId: this.requireActor(),
        }),
      ]);

      return {
        result: await this.require(id, false),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, {
          title,
          folderId: folder.id,
          documentTypeId: policy.id,
          confidentialityId,
          fileObjectId: file.fileObjectId,
          checksumSha256: file.checksumSha256,
          origin: input.origin,
          revisionId: revision.revisionId,
        }),
      };
    });
  }

  async update(
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      categoryId?: string | null;
      confidentialityId?: string;
      metadata?: Readonly<Record<string, MetadataInputValue>>;
    },
    expectedVersion: number | undefined,
  ): Promise<DocumentRow> {
    return this.writer.write<DocumentRow>(async () => {
      const current = await this.require(id, false);
      // Changing the confidentiality level changes who may see the document, and the previous
      // level is not recoverable from the new one by anybody who did not see it. Everything else
      // here is an ordinary edit.
      if (
        patch.confidentialityId !== undefined &&
        patch.confidentialityId !== current.confidentialityId
      ) {
        requireVersion(expectedVersion, current.version);
      } else {
        checkVersion(expectedVersion, current.version);
      }
      this.refuseWhenFrozen(current);

      const title = patch.title === undefined ? undefined : this.requireTitle(patch.title);
      const confidentialityId =
        patch.confidentialityId === undefined
          ? undefined
          : await this.resolveConfidentialityChange(current, patch.confidentialityId);
      const categoryId =
        patch.categoryId === undefined ? undefined : await this.resolveCategory(patch.categoryId);

      await this.documents.update(asId<DocumentId>(id), current.version, {
        ...(title !== undefined && { title }),
        ...(patch.description !== undefined && {
          description: patch.description === null ? null : squish(patch.description),
        }),
        ...(categoryId !== undefined && { categoryId }),
        ...(confidentialityId !== undefined && { confidentialityId }),
      });

      if (patch.metadata !== undefined) {
        const policy = await this.requireType(current.documentTypeId);
        await this.documents.replaceMetadata(
          asId<DocumentId>(id),
          await this.resolveMetadata(policy, patch.metadata),
        );
      }

      return {
        result: await this.require(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          {
            ...(title !== undefined && { title: current.title }),
            ...(categoryId !== undefined && { categoryId: current.categoryId }),
            ...(confidentialityId !== undefined && {
              confidentialityId: current.confidentialityId,
            }),
          },
          {
            ...(title !== undefined && { title }),
            ...(categoryId !== undefined && { categoryId }),
            ...(confidentialityId !== undefined && { confidentialityId }),
            ...(patch.metadata !== undefined && { metadataFields: Object.keys(patch.metadata) }),
          },
        ),
      };
    });
  }

  /**
   * Moves a document to another folder.
   *
   * Its own operation because of what it does beyond changing a column: the folder is the chain
   * the ACL resolver walks, so every grant along the old chain stops applying and every grant along
   * the new one starts. `requireVersion` rather than `checkVersion` for the same reason — a blind
   * move is a change to who can see a document, made by somebody who has not looked at where it is.
   */
  async move(
    id: string,
    folderId: string,
    expectedVersion: number | undefined,
  ): Promise<DocumentRow> {
    return this.writer.write<DocumentRow>(async () => {
      const current = await this.require(id, false);
      requireVersion(expectedVersion, current.version);
      this.refuseWhenFrozen(current);

      const folder = await this.placement.folder(folderId);
      if (folder === null) {
        throw new ValidationError('That folder does not exist.', [
          { field: 'folderId', message: 'unknown' },
        ]);
      }
      if (folder.id === current.folderId) {
        // Not an error — a client retrying a move it already made should succeed — but not a write
        // either, and certainly not an audit entry claiming a move that did not happen.
        return {
          result: current,
          change: this.moved(id, current.folderId, folder.id, true),
        };
      }

      await this.documents.move(asId<DocumentId>(id), current.version, folder.id);
      await this.outbox.publish([
        documentMovedEvent(asId<AnyId>(id), {
          documentId: id,
          fromFolderId: current.folderId,
          toFolderId: folder.id,
        }),
      ]);

      return {
        result: await this.require(id, false),
        change: this.moved(id, current.folderId, folder.id, false),
      };
    });
  }

  /**
   * Soft-deletes a document.
   *
   * The blob's reference is given back here, and that is the only thing that happens to the bytes.
   * Nothing is deleted from storage: retention decides that later, at a reference count of zero,
   * after a grace period. A delete that removed bytes would make the recycle bin a lie
   * ([ADR-0010](../../../../../docs/architecture/adr/0010-soft-delete-and-retention.md)).
   *
   * The document number, if one had been assigned, stays reserved forever — which is why its unique
   * constraint is the one in this schema that is *not* partial on `deleted_at`.
   */
  async remove(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, false);
      requireVersion(expectedVersion, current.version);
      this.refuseWhenFrozen(current);

      await this.documents.setDeleted(asId<DocumentId>(id), current.version, true);
      if (current.latestRevision !== null) {
        await this.content.dereference(current.latestRevision.file.fileObjectId);
      }
      await this.outbox.publish([
        documentDeletedEvent(asId<AnyId>(id), {
          documentId: id,
          deletedBy: this.requireActor(),
          // Null: deleting a document deletes one document. The cascade identifier exists for the
          // folder delete that takes a subtree with it, and stamping a lone delete with one would
          // make a later restore of that folder resurrect this document too.
          cascadeId: null,
          previousStatus: current.status,
        }),
      ]);

      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.DELETED,
          { deletedAt: null },
          {
            title: current.title,
            documentNumber: current.documentNumber,
          },
        ),
      };
    });
  }

  async restore(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, true);
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt === null) {
        return {
          result: undefined,
          change: this.changed(id, AdministrativeOperation.RESTORED, undefined, {
            alreadyLive: true,
          }),
        };
      }
      // The folder has to be back first, or the document would be live and unreachable from the
      // tree — visible to a search and to nothing else.
      const folder = await this.placement.folder(current.folderId);
      if (folder === null) {
        throw new ValidationError('Restore the folder this document was in first.', [
          { field: 'folderId', message: 'deleted' },
        ]);
      }

      await this.documents.setDeleted(asId<DocumentId>(id), current.version, false);
      if (current.latestRevision !== null) {
        await this.content.reference(current.latestRevision.file.fileObjectId);
      }

      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.RESTORED,
          { deletedAt: current.deletedAt },
          { title: current.title },
        ),
      };
    });
  }

  // --- Favourites ------------------------------------------------------------------------

  /**
   * Marks or unmarks a document for one person.
   *
   * Not audited, and that is deliberate rather than an omission. The audit trail is evidence about
   * a controlled record, and whether somebody bookmarked it is not a fact about the record — it is
   * a fact about a menu. Writing one hash-chained, immutable, retention-governed row per click on a
   * star would dilute the trail with the one kind of event that can never matter to an
   * investigation (`13-audit-architecture.md` §3).
   */
  async setFavorite(id: string, favorite: boolean): Promise<void> {
    await this.writer.read(async () => {
      await this.require(id, false);
      const userId = this.requireActor();
      if (favorite) {
        await this.activity.addFavorite(userId, id);
      } else {
        await this.activity.removeFavorite(userId, id);
      }
    });
  }

  /** A short-lived download URL, audited before it exists. The gate lives in Storage. */
  async downloadUrl(id: string, inline: boolean): Promise<{ url: string; expiresAt: Date }> {
    return this.writer.read(async () => {
      const document = await this.require(id, false);
      if (document.latestRevision === null) {
        throw new NotFoundError('The requested file');
      }
      const level = await this.configuration.confidentiality(document.confidentialityId);
      if (level !== null && !level.allowDownload) {
        // A confidentiality level subtracts and never grants: holding `document:download` is not
        // enough if the document's own classification forbids it (`08-permission-model.md` §4).
        throw new ForbiddenError('download this document');
      }
      return this.content.downloadUrl(
        document.latestRevision.file.fileObjectId,
        document.latestRevision.file.filename,
        { inline },
      );
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private async require(id: string, includeDeleted: boolean): Promise<DocumentRow> {
    const row = await this.documents.findById(asId<DocumentId>(id), includeDeleted);
    if (row === null) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private async requireType(id: string): Promise<DocumentTypePolicy> {
    const policy = await this.configuration.documentType(id);
    if (policy === null) {
      throw new ValidationError('That document type does not exist.', [
        { field: 'documentTypeId', message: 'unknown' },
      ]);
    }
    if (!policy.isActive) {
      // An inactive type stays attached to the documents that already use it and cannot be chosen
      // for a new one — which is what "retire a type" has to mean if history is to stay readable.
      throw new ValidationError('That document type is no longer in use.', [
        { field: 'documentTypeId', message: 'inactive' },
      ]);
    }
    return policy;
  }

  private async requireAttachable(fileObjectId: string) {
    const file = await this.content.describe(fileObjectId);
    if (file === null) {
      throw new ValidationError('That upload could not be found.', [
        { field: 'fileObjectId', message: 'unknown' },
      ]);
    }
    if (file.scanStatus !== ScanStatus.CLEAN) {
      // The gate, in the use case. The database trigger refuses the same write, and both are
      // wanted: this one produces an answer a person can read, and that one still holds when a
      // repair script is what is doing the writing.
      throw new ContentNotScannedError(file.scanStatus);
    }
    return file;
  }

  /**
   * The level a new document carries.
   *
   * Defaults to the type's, and an explicit choice may only be *more* sensitive. That asymmetry is
   * the permission model's: every handling rule on a level subtracts, so choosing a lower rank at
   * creation would be a way to grant access the type's author decided against — by picking it from
   * a dropdown.
   */
  private async resolveConfidentiality(
    policy: DocumentTypePolicy,
    chosen: string | undefined,
  ): Promise<string> {
    if (chosen === undefined || chosen === policy.defaultConfidentialityId) {
      return policy.defaultConfidentialityId;
    }
    const [level, fallback] = await Promise.all([
      this.configuration.confidentiality(chosen),
      this.configuration.confidentiality(policy.defaultConfidentialityId),
    ]);
    if (level === null) {
      throw new ValidationError('That confidentiality level does not exist.', [
        { field: 'confidentialityId', message: 'unknown' },
      ]);
    }
    if (fallback !== null && level.rank < fallback.rank) {
      throw new ValidationError('A document cannot be less sensitive than its type’s default.', [
        { field: 'confidentialityId', message: 'below default' },
      ]);
    }
    return level.id;
  }

  private async resolveConfidentialityChange(
    current: DocumentRow,
    chosen: string,
  ): Promise<string> {
    const level = await this.configuration.confidentiality(chosen);
    if (level === null) {
      throw new ValidationError('That confidentiality level does not exist.', [
        { field: 'confidentialityId', message: 'unknown' },
      ]);
    }
    if (level.rank < current.confidentialityRank) {
      // Declassifying is a decision with its own procedure and its own permission, and it is not
      // Phase 3's. Refusing it is the honest position: allowing it here would make "reduce
      // sensitivity" an ordinary edit that any document editor can perform.
      throw new ValidationError('Reducing a document’s confidentiality is not done from here.', [
        { field: 'confidentialityId', message: 'declassification' },
      ]);
    }
    return level.id;
  }

  private async resolveCategory(categoryId: string | null): Promise<string | null> {
    if (categoryId === null) {
      return null;
    }
    if (!(await this.configuration.categoryExists(categoryId))) {
      throw new ValidationError('That category does not exist.', [
        { field: 'categoryId', message: 'unknown' },
      ]);
    }
    return categoryId;
  }

  /**
   * The tenant's own fields, coerced to their columns and checked.
   *
   * Every rejection is reported at once rather than one per save: a fifteen-field document type
   * with four mistakes in it should take one round trip to correct, not four.
   */
  private async resolveMetadata(
    policy: DocumentTypePolicy,
    supplied: Readonly<Record<string, MetadataInputValue>>,
  ) {
    const { values, rejections } = coerceMetadata(policy.fields, supplied);
    if (rejections.length > 0) {
      throw new ValidationError(
        'Some of this document’s details need attention.',
        rejections.map((rejection) => ({ field: rejection.field, message: rejection.message })),
      );
    }

    // Shape is decidable in the domain; existence is not. A `USER` field naming somebody who does
    // not work here would otherwise be stored and only noticed when a screen rendered a blank.
    for (const { field, id } of referenceFieldsIn(policy.fields, values)) {
      const exists =
        field.dataType === MetadataDataType.USER
          ? await this.configuration.userExists(id)
          : await this.configuration.departmentExists(id);
      if (!exists) {
        throw new ValidationError('Some of this document’s details need attention.', [
          { field: field.key, message: `${field.name} does not name anyone here.` },
        ]);
      }
    }
    return values;
  }

  /**
   * Refuses an edit to a document whose content is frozen.
   *
   * Phase 3 creates documents in `DRAFT` and nothing moves them out of it, so today this only ever
   * passes. It is written now because the transition table is Phase 4's and the *rule* is not: a
   * submitted document's content is frozen from the moment it is handed to a workflow
   * (`06-document-lifecycle.md`), and an edit path built without the check is an edit path somebody
   * has to remember to add one to.
   */
  private refuseWhenFrozen(document: DocumentRow): void {
    if (FROZEN_STATUSES.has(document.status)) {
      throw new ValidationError('This document is in approval and cannot be edited.', [
        { field: 'status', message: document.status },
      ]);
    }
  }

  private requireTitle(raw: string): string {
    const title = squish(raw);
    if (title.length === 0) {
      throw new ValidationError('A title is required.', [{ field: 'title', message: 'required' }]);
    }
    return title;
  }

  private requireActor(): string {
    const { userId } = requireContext();
    if (userId === null) {
      // Documents are created by people. The system creates configuration during provisioning and
      // never creates a controlled record, so a null actor here is a bug rather than a case.
      throw new ForbiddenError('create a document without a signed-in user');
    }
    return userId;
  }

  private changed(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action: DocumentAudit.DOCUMENT_CHANGED,
      subjectType: AuditSubjectType.DOCUMENT,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before }),
      ...(after && { after }),
    };
  }

  private moved(id: string, from: string, to: string, unchanged: boolean) {
    return {
      action: DocumentAudit.DOCUMENT_MOVED,
      subjectType: AuditSubjectType.DOCUMENT,
      subjectId: asId<AnyId>(id),
      operation: AdministrativeOperation.MOVED,
      before: { folderId: from },
      after: { folderId: to, ...(unchanged && { unchanged: true }) },
    };
  }
}

/** Content is frozen from submission onward. Phase 4 is what puts a document into these. */
const FROZEN_STATUSES: ReadonlySet<string> = new Set([
  DocumentStatus.SUBMITTED,
  DocumentStatus.UNDER_REVIEW,
  DocumentStatus.APPROVED,
  DocumentStatus.PUBLISHED,
  DocumentStatus.SUPERSEDED,
  DocumentStatus.ARCHIVED,
]);

/** Re-exported so a caller naming an origin does not have to reach into the domain package. */
export { DocumentOrigin };
