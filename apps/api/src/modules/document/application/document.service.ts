import { Inject, Injectable } from '@nestjs/common';

import {
  ActorChannel,
  type AnyId,
  AuditOutcome,
  AuditSubjectType,
  type DocumentId,
  DocumentOrigin,
  type DocumentOriginKey,
  DocumentStatus,
  type DocumentStatusKey,
  MetadataDataType,
  RetentionTrigger,
  RevisionStatus,
  ScanStatus,
  ScopeType,
  type UserId,
  asId,
} from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  ContentNotScannedError,
  DuplicateError,
  ForbiddenError,
  InvalidTransitionError,
  LegalHoldError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { READ_AUDIT_BUFFER, type ReadAuditBuffer } from '../../../core/audit/read-audit.port';
import {
  AdministeredWriter,
  AdministrativeOperation,
  type AdministrativeOperationKey,
  checkVersion,
  requireVersion,
} from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  ORGANIZATION_SERVICE,
  type OrganizationService,
} from '../../organization/application/ports';
import { DocumentAudit } from '../domain/audit-actions';
import { implementedTransitionsFrom, isFrozen, isLegalTransition } from '../domain/lifecycle';
import {
  documentCreatedEvent,
  documentDeletedEvent,
  documentMovedEvent,
  documentRestoredEvent,
} from '../domain/events';
import {
  type MetadataInputValue,
  coerceMetadata,
  readMetadata,
  referenceFieldsIn,
} from '../domain/metadata';
import {
  LEGAL_HOLD_SERVICE,
  RETENTION_SCHEDULER,
  type LegalHoldService,
  type RetentionScheduler,
} from '../../retention/application/ports';
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
    @Inject(ORGANIZATION_SERVICE) private readonly organization: OrganizationService,
    @Inject(DOCUMENT_CONTENT_GATE) private readonly content: DocumentContentGate,
    @Inject(REVISION_WRITER) private readonly revisions: RevisionWriter,
    @Inject(DOCUMENT_THUMBNAILER) private readonly thumbnails: DocumentThumbnailer,
    @Inject(LEGAL_HOLD_SERVICE) private readonly holds: LegalHoldService,
    @Inject(RETENTION_SCHEDULER) private readonly retention: RetentionScheduler,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(READ_AUDIT_BUFFER) private readonly readAudit: ReadAuditBuffer,
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
   * Whether a live document with this identifier exists in this tenant.
   *
   * Declared on `DOCUMENT_SERVICE` since Phase 0.5 and implemented here in Phase 16, when a
   * consumer typed against the port finally revealed that the class satisfying it did not have
   * the method. It was never reachable at runtime — Nest's `useClass` does not structurally check
   * a provider against its token — which is exactly why it went eleven phases unnoticed.
   *
   * A boolean rather than a row, and a *live* row rather than any row: the callers of this port
   * are other modules asking "is this a document I can point at", and a deleted one is not.
   */
  async exists(id: DocumentId): Promise<boolean> {
    return this.writer.read(async () => (await this.documents.findById(id, false)) !== null);
  }

  /**
   * Opens a document: returns it, remembers that this person saw it, and says so in the trail.
   *
   * Separate from `get` on purpose. A list that rendered twenty rows has not been *opened* twenty
   * times, and a "recent documents" list built from every read would be a list of whatever the
   * screen last drew. Only an explicit open counts.
   *
   * The view goes to the **read-audit buffer** rather than into this transaction — Phase 9's
   * change, and 13 §5's requirement since Phase 0. Writing it inline took the tenant's audit
   * advisory lock on every page view, so a document everybody reads throttled every approval and
   * publication in the same organisation. It is still hash-chained; it is chained a batch at a
   * time under one lock instead of one row at a time under a hundred.
   *
   * Losing the atomicity with the "recent" row is the deliberate part: a read is not a change, and
   * an event whose whole content is "somebody looked" has nothing it must commit *with*.
   */
  async open(id: string): Promise<DocumentRow> {
    const document = await this.writer.read(async () => {
      const row = await this.require(id, false);
      const { userId } = requireContext();
      if (userId !== null) {
        await this.activity.recordView(userId, id, this.writer.clock.now());
      }
      return row;
    });

    const context = requireContext();
    await this.readAudit.record(
      {
        tenantId: context.tenantId,
        userId: context.userId,
        channel: ActorChannel.WEB,
        correlationId: context.correlationId,
        ipAddress: null,
        userAgent: null,
      },
      {
        action: DocumentAudit.DOCUMENT_VIEWED,
        subjectType: AuditSubjectType.DOCUMENT,
        subjectId: asId<AnyId>(id),
        outcome: AuditOutcome.SUCCESS,
        // The confidentiality level is in the payload because it is what decides whether this
        // event had to be written at all: levels that demand audit-on-read are the reason the
        // action exists, and a report filtering for them needs the level, not a join.
        payload: {
          operation: AdministrativeOperation.UPDATED,
          after: {
            confidentialityId: document.confidentialityId,
            confidentialityRank: document.confidentialityRank,
          },
        },
      },
    );
    return document;
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
          revisionId: revision.revisionId,
          fileObjectId: file.fileObjectId,
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
   * Soft-deletes a document, with the three rules Phase 10 added to Phase 3's shape.
   *
   * **A reason is mandatory.** Stored on the row — the recycle bin shows it beside the entry —
   * and written to the trail's own `reason` column, where the widened digest attests it.
   *
   * **A legal hold refuses absolutely** (ADR-0010 §5). Not a permission failure: nothing the
   * caller could be granted would let this through, and the error says so.
   *
   * **The delete cascades over every live revision**, stamped with one cascade identifier, and
   * gives back each revision's blob reference — not merely the latest, which was Phase 3's shape
   * and meant a document with four revisions returned one reference and its blobs could never
   * reach zero. `DOCUMENT_DELETION_RULES` in `@edms/domain` is the whole table, and the restore
   * reverses exactly this cascade.
   *
   * Nothing is deleted from storage: retention decides that later, at a reference count of zero,
   * after a grace period. A delete that removed bytes would make the recycle bin a lie
   * ([ADR-0010](../../../../../docs/architecture/adr/0010-soft-delete-and-retention.md)). The
   * document number, if one had been assigned, stays reserved forever.
   */
  async remove(id: string, expectedVersion: number | undefined, reason: string): Promise<void> {
    const stated = squish(reason);
    if (stated.length === 0) {
      throw new ValidationError('A reason is required.', [
        { field: 'reason', message: 'required' },
      ]);
    }

    await this.writer.write(async () => {
      const current = await this.require(id, false);
      requireVersion(expectedVersion, current.version);
      this.refuseWhenFrozenForDelete(current);

      const holds = await this.holds.listFor(asId<DocumentId>(id));
      const live = holds.filter((hold) => hold.releasedAt === null);
      if (live.length > 0) {
        throw new LegalHoldError(id, live.length);
      }

      const cascadeId = this.writer.clock.nextId();
      await this.documents.setDeleted(asId<DocumentId>(id), current.version, true, {
        reason: stated,
        cascadeId,
      });
      const revisions = await this.revisions.cascadeDelete(id, cascadeId);
      for (const revision of revisions) {
        if (revision.referenced) {
          await this.content.dereference(revision.fileObjectId);
        }
      }

      // The delete may start a clock: the frozen policy's ON_DELETE trigger, or — for a draft
      // that was never numbered — the recycle-bin window, which is what finally makes "drafts may
      // be permanently deleted" true without a purge button.
      await this.retention.onTrigger({
        documentId: asId<DocumentId>(id),
        trigger: RetentionTrigger.ON_DELETE,
        at: this.writer.clock.now(),
        policyId: current.retentionPolicyId,
        documentNumber: current.documentNumber,
      });

      await this.outbox.publish([
        documentDeletedEvent(asId<AnyId>(id), {
          documentId: id,
          deletedBy: this.requireActor(),
          cascadeId,
          previousStatus: current.status,
        }),
      ]);

      return {
        result: undefined,
        change: {
          ...this.changed(
            id,
            AdministrativeOperation.DELETED,
            { deletedAt: null },
            {
              title: current.title,
              documentNumber: current.documentNumber,
              cascadeId,
              revisionsCascaded: revisions.length,
            },
          ),
          reason: stated,
        },
      };
    });
  }

  /**
   * Restores a deleted document — to the state it was deleted from, never a higher one.
   *
   * The revisions come back by the delete's own cascade identifier, so a restore returns exactly
   * what that delete took: a revision discarded before the delete stays discarded, and a document
   * deleted on its own is not resurrected by restoring the folder deleted after it. The schedule
   * the delete wrote is withdrawn — and only that one; deleting and restoring a published record
   * must not reset the clock its publication started.
   */
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

      const cascadeId = await this.documents.cascadeIdOf(asId<DocumentId>(id));
      await this.documents.setDeleted(asId<DocumentId>(id), current.version, false);

      if (cascadeId !== null) {
        const revisions = await this.revisions.restoreCascade(id, cascadeId);
        for (const revision of revisions) {
          if (revision.referenced) {
            await this.content.reference(revision.fileObjectId);
          }
        }
      } else if (current.latestRevision !== null) {
        // Deleted by a release before the cascade existed: nothing stamped the revisions, so the
        // exact inverse of that delete is Phase 3's — the latest revision's reference comes back.
        await this.content.reference(current.latestRevision.file.fileObjectId);
      }

      await this.retention.onRestored(asId<DocumentId>(id));

      await this.outbox.publish([
        documentRestoredEvent(asId<AnyId>(id), {
          documentId: id,
          restoredTo: current.status,
          renamedTo: null,
        }),
      ]);

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
      // The *effective* content when one exists. After a check-in the latest revision is an
      // unapproved draft, and "the published revision stays effective until the new one
      // publishes" (`06-document-lifecycle.md` §3) applies to downloads before anything else.
      // A draft's own bytes are reachable through the revision history endpoint, deliberately
      // behind `document:history:view`.
      const revision = document.currentRevision ?? document.latestRevision;
      if (revision === null) {
        throw new NotFoundError('The requested file');
      }
      const level = await this.configuration.confidentiality(document.confidentialityId);
      if (level !== null && !level.allowDownload) {
        // A confidentiality level subtracts and never grants: holding `document:download` is not
        // enough if the document's own classification forbids it (`08-permission-model.md` §4).
        throw new ForbiddenError('download this document');
      }
      return this.content.downloadUrl(revision.file.fileObjectId, revision.file.filename, {
        inline,
      });
    });
  }

  // --- What the workflow engine asks ------------------------------------------------------

  /**
   * Everything an approval needs to know about a document, in one read.
   *
   * Assembled here rather than in the engine, and the assembly is the security-relevant part.
   * `07-workflow-architecture.md` §2 says a stage condition is "evaluated by a pure function; no
   * expression ever reaches an evaluator that can touch I/O or the database" — so the facts a
   * tenant-authored expression is compared against are gathered *before* evaluation, by code that
   * knows what it is fetching, into a flat map of pre-approved keys. The evaluator does a lookup
   * and a comparison; it has nothing to reach with and nothing to reach into.
   *
   * A `Map` rather than an object for the same reason. A tenant names the keys, and a plain object
   * whose keys a tenant names is one `condition.field` of `"constructor"` away from resolving
   * something that is not a fact about their document.
   */
  async approvalContext(id: string): Promise<DocumentApprovalFacts | null> {
    return this.writer.read(async () => {
      const document = await this.documents.findById(asId<DocumentId>(id), false);
      if (document === null) {
        return null;
      }
      const [policy, level, category, folder] = await Promise.all([
        this.configuration.documentType(document.documentTypeId),
        this.configuration.confidentiality(document.confidentialityId),
        document.categoryId === null
          ? Promise.resolve(null)
          : this.configuration.category(document.categoryId),
        this.placement.folder(document.folderId),
      ]);

      const placement = await this.organisationalPlacement(folder);
      const facts = new Map<string, FactValue>([
        ['documentType.code', policy?.code ?? null],
        ['category.code', category?.code ?? null],
        ['confidentiality.rank', level?.rank ?? null],
        ['department.code', placement.departmentCode],
        ['entity.code', placement.entityCode],
        // Computed rather than stored: "is this the first controlled version" is what a workflow
        // author means by a first issue, and it is the ordinal rather than a flag anybody maintains.
        ['revision.isFirst', (document.latestRevision?.ordinal ?? 0) === 0],
        ['revision.ordinal', document.latestRevision?.ordinal ?? 0],
      ]);

      const userFields = new Map<string, UserId>();
      for (const entry of document.metadata) {
        const value = readMetadata(entry.dataType, entry.columns);
        facts.set(`metadata.${entry.key}`, toFact(value));
        if (entry.dataType === MetadataDataType.USER && typeof value === 'string') {
          // A `DOCUMENT_FIELD` resolver names one of these by key — "Reviewer" — and the engine
          // never learns which fields exist, only that it was handed the people they name.
          userFields.set(entry.key, asId<UserId>(value));
        }
      }

      return {
        documentId: asId<DocumentId>(document.id),
        status: document.status,
        title: document.title,
        documentTypeId: document.documentTypeId,
        documentTypeName: document.documentTypeName,
        workflowDefinitionId: policy?.workflowDefinitionId ?? null,
        ownerUserId: document.ownerUserId,
        // `createdBy` is the author. Distinct from the owner, which can be reassigned — and
        // `MANAGER_OF: AUTHOR` means the person who wrote it, not whoever holds it now.
        authorUserId: document.createdBy === null ? null : asId<UserId>(document.createdBy),
        latestRevisionId: document.latestRevisionId,
        latestRevisionLabel: document.latestRevision?.label ?? null,
        entityId: placement.entityId,
        departmentId: placement.departmentId,
        userFields,
        facts,
      };
    });
  }

  /**
   * Moves a document through its lifecycle, on the engine's instruction.
   *
   * The transition is checked against `LEGAL_TRANSITIONS` rather than against a condition written
   * here, which is `06-document-lifecycle.md` §5's first rule: the table is the only source of
   * truth, and a status check written inline is one that disagrees with it the first time somebody
   * adds a state.
   *
   * An illegal pair is a `409` naming both halves. That matters more than it looks — the engine
   * calls this several times in one approval, and a silent no-op would leave a document in a state
   * its own approval believes it is not in.
   */
  async applyLifecycleTransition(input: {
    readonly documentId: string;
    readonly to: DocumentStatusKey;
    readonly workflowInstanceId: string | null;
    readonly reason: string | null;
  }): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(input.documentId, false);
      if (current.status === input.to) {
        // Idempotent by design. The engine transitions to `UNDER_REVIEW` as each stage activates,
        // and a second stage activating must not be a conflict.
        return {
          result: undefined,
          change: this.transitioned(input, current.status, true),
        };
      }
      if (!isLegalTransition(current.status, input.to)) {
        throw new InvalidTransitionError(current.status, input.to);
      }

      await this.documents.setStatus(asId<DocumentId>(input.documentId), current.version, input.to);

      // The revision's own, smaller machine, kept in step (`06-document-lifecycle.md` §1: the
      // document's status and the revision's are two machines). Submission freezes the draft
      // into IN_APPROVAL; every road back to an editable document — withdrawal, a change
      // request, a rejection being revised — returns it to DRAFT. Guarded on the current state
      // in the writer, so a transition that finds the revision elsewhere leaves it alone: the
      // fresh draft a check-in just created is already DRAFT when the document follows it.
      if (current.latestRevisionId !== null) {
        if (input.to === DocumentStatus.SUBMITTED) {
          await this.revisions.setWorkingStatus({
            revisionId: current.latestRevisionId,
            from: [RevisionStatus.DRAFT],
            to: RevisionStatus.IN_APPROVAL,
          });
        } else if (
          input.to === DocumentStatus.DRAFT ||
          input.to === DocumentStatus.CHANGES_REQUESTED ||
          input.to === DocumentStatus.REJECTED
        ) {
          await this.revisions.setWorkingStatus({
            revisionId: current.latestRevisionId,
            from: [RevisionStatus.IN_APPROVAL],
            to: RevisionStatus.DRAFT,
          });
        }
      }

      return {
        result: undefined,
        change: this.transitioned(input, current.status, false),
      };
    });
  }

  /**
   * The transitions this document can make right now.
   *
   * Answered from `IMPLEMENTED_TRANSITIONS` rather than from the full table, because §5's rule is
   * that "the UI asks the API for the available transitions and renders exactly those" — and
   * offering one that nothing performs would make the client render a button that returns a 404.
   */
  async availableTransitions(id: string): Promise<readonly DocumentStatusKey[]> {
    const document = await this.writer.read(() => this.require(id, false));
    return implementedTransitionsFrom(document.status);
  }

  // --- Internals -------------------------------------------------------------------------

  /**
   * Where a document sits in the organisation: its entity and its department, if any.
   *
   * Walked from the library's owning node rather than stored on the document, because it is the
   * library's position and a document that moves between libraries moves with it. A library owned
   * by a department is inside an entity too, which is why this reads the chain rather than the node.
   */
  private async organisationalPlacement(
    folder: {
      readonly ownerScopeType: string;
      readonly ownerScopeId: string | null;
    } | null,
  ): Promise<{
    entityId: string | null;
    entityCode: string | null;
    departmentId: string | null;
    departmentCode: string | null;
  }> {
    const empty = { entityId: null, entityCode: null, departmentId: null, departmentCode: null };
    if (folder === null || folder.ownerScopeId === null) {
      return empty;
    }
    const chain = await this.organization.scopeChainFor(
      asId<AnyId>(folder.ownerScopeId),
      folder.ownerScopeType as never,
    );
    const entity = chain.find((node) => node.type === ScopeType.ENTITY);
    // The *deepest* department in the chain: a library owned by a sub-team belongs to that team,
    // not to the parent the walk started from. `findLast` is not available on the target lib, so
    // the chain is reversed rather than searched backwards by index.
    const department = [...chain].reverse().find((node) => node.type === ScopeType.DEPARTMENT);
    return {
      entityId: entity?.id ?? null,
      entityCode: entity?.code ?? null,
      departmentId: department?.id ?? null,
      departmentCode: department?.code ?? null,
    };
  }

  private transitioned(
    input: {
      readonly documentId: string;
      readonly to: DocumentStatusKey;
      readonly workflowInstanceId: string | null;
      readonly reason: string | null;
    },
    from: DocumentStatusKey,
    unchanged: boolean,
  ) {
    return {
      action: DocumentAudit.DOCUMENT_CHANGED,
      subjectType: AuditSubjectType.DOCUMENT,
      subjectId: asId<AnyId>(input.documentId),
      operation: AdministrativeOperation.UPDATED,
      before: { status: from },
      // `from`, `to`, the reason and the workflow instance — which is what §5 asks every executed
      // transition to record.
      after: {
        status: input.to,
        workflowInstanceId: input.workflowInstanceId,
        reason: input.reason,
        ...(unchanged && { unchanged: true }),
      },
    };
  }

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
   * Written in Phase 3 against statuses nothing could reach; Phase 4 is what makes it fire. The set
   * moved to `domain/lifecycle.ts` with the transition table it belongs to, because "the bytes under
   * review must be the bytes approved" is a row of that table rather than a rule of this service.
   */
  private refuseWhenFrozen(document: DocumentRow): void {
    if (isFrozen(document.status)) {
      throw new ValidationError('This document is in approval and cannot be edited.', [
        { field: 'status', message: document.status },
      ]);
    }
  }

  /**
   * A delete is not an edit, so it answers to the lifecycle table rather than to the frozen set:
   * `ARCHIVED → DELETED` is legal — it is how a record leaves the shelf — while a published or
   * in-approval document still refuses, because deleting the controlled copy everyone is reading
   * is a decision retention makes, never a click.
   */
  private refuseWhenFrozenForDelete(document: DocumentRow): void {
    if (!isLegalTransition(document.status, DocumentStatus.DELETED)) {
      throw new InvalidTransitionError(document.status, DocumentStatus.DELETED);
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

/**
 * A document as an approval sees it.
 *
 * Declared here rather than in Workflow's ports, even though Workflow is what asks for it, because
 * Document is what knows how to assemble one — and the adapter in Workflow's infrastructure maps it
 * to Workflow's own vocabulary. Two shapes that happen to look alike, owned by the module that can
 * be wrong about each.
 */
export interface DocumentApprovalFacts {
  readonly documentId: DocumentId;
  readonly status: DocumentStatusKey;
  readonly title: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly workflowDefinitionId: string | null;
  readonly ownerUserId: UserId;
  readonly authorUserId: UserId | null;
  readonly latestRevisionId: string | null;
  readonly latestRevisionLabel: string | null;
  readonly entityId: string | null;
  readonly departmentId: string | null;
  readonly userFields: ReadonlyMap<string, UserId>;
  readonly facts: ReadonlyMap<string, FactValue>;
}

/** What a condition may be compared against. Deliberately not `unknown`. */
export type FactValue = string | number | boolean | readonly string[] | null;

/** A stored metadata value, narrowed to the fact set. A list stays a list; everything else is scalar. */
function toFact(value: string | number | boolean | readonly string[] | null): FactValue {
  return value;
}

/** Re-exported so a caller naming an origin does not have to reach into the domain package. */
export { DocumentOrigin };
