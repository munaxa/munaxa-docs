import type { AnyId, DocumentId, TenantId } from '@edms/domain';

/**
 * Full-text and metadata search.
 *
 * PostgreSQL carries the first generation behind this port; an external engine replaces the
 * adapter without touching a use case
 * (`docs/architecture/adr/0008-postgres-first-search.md`).
 *
 * The port takes the caller's permission fingerprint because results must be filtered
 * *before* scoring — fetch-then-filter leaks totals, facet counts and page boundaries. Facet
 * counts are computed after that predicate for the same reason: a count over documents the
 * caller cannot read is the leak the predicate exists to prevent.
 *
 * **Phase 8 replaced the Phase 0.5 sketch of these shapes**, the same procedure as Phase 7's
 * renderer ports and for the same recorded reason: the skeleton had offset pagination where
 * `12-search-architecture.md` §5 specifies keyset on `(rank, document_id)`, hits that carried
 * nothing a result list could render, and no way to express the audited `search:all` bypass.
 * The next phase that trusts a skeleton port's shape over the built one will repeat it.
 */
export const SEARCH_PORT = Symbol('SearchPort');

export interface SearchSubject {
  readonly tenantId: TenantId;
  /** User, role and department tokens the index is filtered against. */
  readonly subjectIds: readonly AnyId[];
  /**
   * True only for a caller holding `search:all`: the ACL predicate is skipped, the tenant
   * predicate never is, and the caller's search is audited
   * (`docs/architecture/12-search-architecture.md` §3).
   */
  readonly unrestricted: boolean;
}

export interface SearchQuery {
  readonly text: string | null;
  /** Structured filters keyed by the engine's filter vocabulary — never raw SQL fragments. */
  readonly filters: Readonly<Record<string, readonly string[]>>;
  /** Which facets to count, post-filter. */
  readonly facets: readonly string[];
  readonly sort: 'RELEVANCE' | 'RECENT' | 'NUMBER' | 'TITLE';
  /** Keyset cursor from the previous page's `nextCursor`; null for the first page. */
  readonly cursor: string | null;
  readonly limit: number;
}

/** One run of highlighted-or-not text; a fragment is a list of these, safe to render as-is. */
export interface HighlightSpan {
  readonly text: string;
  readonly hit: boolean;
}

/** What a result list renders without a second query per row. */
export interface SearchHitSummary {
  readonly title: string;
  readonly documentNumber: string | null;
  readonly status: string;
  readonly documentTypeId: string;
  readonly categoryId: string | null;
  readonly libraryId: string;
  readonly folderId: string;
  readonly ownerId: string;
  readonly filename: string | null;
  readonly revisionOrdinal: number | null;
  readonly revisionLabel: string | null;
  readonly language: string;
  /** Null when no extracted text is indexed; `OCR` marks an inference, not the file's words. */
  readonly bodySource: 'TEXT' | 'OCR' | null;
  /** The preview pipeline has not yet answered for this revision — say "pending", not "done". */
  readonly contentPending: boolean;
  readonly lowConfidence: boolean;
  readonly confidentialityRank: number;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
  readonly effectiveFrom: Date | null;
}

export interface SearchHit {
  readonly documentId: DocumentId;
  readonly score: number;
  readonly summary: SearchHitSummary;
  /** Field name to highlighted fragments, already segmented for safe rendering. */
  readonly highlights: Readonly<Record<string, ReadonlyArray<readonly HighlightSpan[]>>>;
}

export interface FacetBucket {
  readonly value: string;
  readonly count: number;
}

export interface SearchResults {
  readonly hits: readonly SearchHit[];
  /** Post-filter total — safe to show, because the predicate already ran. */
  readonly total: number;
  readonly facets: Readonly<Record<string, readonly FacetBucket[]>>;
  /** Null when this page is the last one. */
  readonly nextCursor: string | null;
}

/**
 * What the projection writes; rebuildable from source at any time, never authoritative.
 * The engine derives its own text index from the fields — the weighted `tsvector` for
 * PostgreSQL, analyzed fields for an external engine — so nothing above the port knows how
 * text is analysed.
 */
export interface IndexDocument {
  readonly documentId: DocumentId;
  readonly tenantId: TenantId;
  readonly title: string;
  readonly documentNumber: string | null;
  readonly description: string | null;
  readonly filename: string | null;
  /** Searchable metadata values, flattened to text for the B weight. */
  readonly metadataText: string;
  /** Metadata values keyed by field id, for display and structured filtering. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly bodySource: 'TEXT' | 'OCR' | null;
  readonly contentPending: boolean;
  readonly lowConfidence: boolean;
  /** Detected per revision (`12-search-architecture.md` §4). */
  readonly language: string;
  readonly status: string;
  readonly documentTypeId: string;
  readonly categoryId: string | null;
  readonly confidentialityRank: number;
  readonly entityId: string | null;
  readonly branchId: string | null;
  readonly departmentId: string | null;
  readonly libraryId: string;
  readonly folderId: string;
  readonly folderPath: string;
  readonly ownerId: string;
  readonly approverIds: readonly string[];
  readonly revisionOrdinal: number | null;
  readonly revisionLabel: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
  readonly effectiveFrom: Date | null;
  /** Computed by the ACL resolver — one implementation, two call sites. */
  readonly aclSubjects: readonly string[];
  readonly aclDenySubjects: readonly string[];
  readonly aclHash: string;
  /** The document's own optimistic-lock version as of projection, for staleness detection. */
  readonly sourceVersion: number;
}

export interface SearchPort {
  query(subject: SearchSubject, query: SearchQuery): Promise<SearchResults>;
}

export const INDEX_PORT = Symbol('IndexPort');

/**
 * The write side of the index, including the rebuild's three-step contract: prepare a fresh
 * build target, fill it in batches, then make it live in one atomic step. For PostgreSQL that
 * is the shadow table and a rename swap; for an external engine, a new index and an alias
 * flip. Readers never see a half-built index either way (`12-search-architecture.md` §6).
 */
export interface IndexPort {
  upsert(document: IndexDocument): Promise<void>;
  remove(documentId: DocumentId): Promise<void>;
  /** Empty the build target. Idempotent; a resumed rebuild does NOT call it again. */
  beginRebuild(): Promise<void>;
  /** Bulk-write a batch into the build target, not the live index. */
  rebuildUpsert(documents: readonly IndexDocument[]): Promise<void>;
  /** Remove from the build target, so a document deleted mid-rebuild cannot outlive the swap. */
  rebuildRemove(documentId: DocumentId): Promise<void>;
  /** Atomically make the build target the live index. */
  completeRebuild(): Promise<void>;
}
