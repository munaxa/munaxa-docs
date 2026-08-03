import type {
  CategoryId,
  DocumentId,
  DocumentStatusKey,
  DocumentTypeId,
  FolderId,
  RevisionId,
  UserId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * The product's root aggregate.
 *
 * Its identity never changes: not when it is revised, not when it moves folder, not when it
 * is archived (`docs/architecture/03-domain-model.md` §3).
 */
export const DOCUMENT_REPOSITORY = Symbol('DocumentRepository');
export const DOCUMENT_LOCK_REPOSITORY = Symbol('DocumentLockRepository');
export const DOCUMENT_QUERY_SERVICE = Symbol('DocumentQueryService');

export interface DocumentRecord {
  readonly id: DocumentId;
  readonly folderId: FolderId;
  readonly documentTypeId: DocumentTypeId;
  readonly categoryId: CategoryId | null;
  readonly title: string;
  readonly status: DocumentStatusKey;
  /** Assigned at approval, then immutable — and never reused, even after deletion. */
  readonly documentNumber: string | null;
  readonly ownerUserId: UserId;
  readonly currentRevisionId: RevisionId | null;
  readonly latestRevisionId: RevisionId | null;
  readonly version: number;
}

export interface DocumentRepository {
  findById(id: DocumentId): Promise<DocumentRecord | null>;
  findByNumber(documentNumber: string): Promise<DocumentRecord | null>;
  /** Optimistic locking: a mismatched `version` is a 409, never a silent overwrite. */
  save(document: DocumentRecord, expectedVersion: number): Promise<void>;
  softDelete(id: DocumentId, deletedBy: UserId, cascadeId: string | null): Promise<void>;
  restore(id: DocumentId): Promise<void>;
}

export interface DocumentLockRecord {
  readonly documentId: DocumentId;
  readonly userId: UserId;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}

export interface DocumentLockRepository {
  /** Returns null when another live lock exists — the caller decides whether that is a 423. */
  acquire(
    documentId: DocumentId,
    userId: UserId,
    expiresAt: Date,
  ): Promise<DocumentLockRecord | null>;
  find(documentId: DocumentId): Promise<DocumentLockRecord | null>;
  release(documentId: DocumentId, releasedBy: UserId, forced: boolean): Promise<void>;
}

/** List views for the folder browser and dashboards. Deliberately not the aggregate
 *  repository: forcing every list through an aggregate is how EDMS systems become slow
 *  (`docs/architecture/02-backend-architecture.md` §5). */
export interface DocumentQueryService {
  listInFolder(folderId: FolderId, page: PageRequest): Promise<Page<DocumentRecord>>;
  listOwnedBy(userId: UserId, page: PageRequest): Promise<Page<DocumentRecord>>;
}

export const DOCUMENT_SERVICE = Symbol('DocumentService');

/** What other modules may ask of Document. They never touch its repositories. */
export interface DocumentService {
  get(id: DocumentId): Promise<DocumentRecord | null>;
  exists(id: DocumentId): Promise<boolean>;
  /** The transitions this caller may perform right now, computed server-side. */
  availableTransitions(id: DocumentId): Promise<readonly DocumentStatusKey[]>;
}
