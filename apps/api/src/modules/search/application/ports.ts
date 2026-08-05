import type { DocumentId, RevisionId, UserId } from '@edms/domain';

import type { SearchResults } from '../../../ports/search.port';

/**
 * The index is a read model: rebuildable from source at any time, never authoritative
 * (`docs/architecture/adr/0008-postgres-first-search.md`).
 *
 * Results are filtered by permission **before** scoring. Fetch-then-filter leaks totals,
 * facet counts and page boundaries, which is enough to enumerate a library a user cannot read.
 */
export const SAVED_SEARCH_REPOSITORY = Symbol('SavedSearchRepository');
export const RECENT_SEARCH_REPOSITORY = Symbol('RecentSearchRepository');
export const SEARCH_REBUILD_REPOSITORY = Symbol('SearchRebuildRepository');
export const SEARCH_SOURCE = Symbol('SearchSource');
export const SEARCH_PROJECTION = Symbol('SearchProjection');

export interface SavedSearchRecord {
  readonly id: string;
  readonly ownerId: UserId;
  readonly name: string;
  readonly query: string;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface SavedSearchRepository {
  findById(id: string): Promise<SavedSearchRecord | null>;
  listFor(ownerId: UserId): Promise<readonly SavedSearchRecord[]>;
  create(record: {
    readonly id: string;
    readonly ownerId: UserId;
    readonly name: string;
    readonly query: string;
    readonly filters: Readonly<Record<string, readonly string[]>>;
  }): Promise<void>;
  update(
    id: string,
    expectedVersion: number,
    changes: {
      readonly name?: string;
      readonly query?: string;
      readonly filters?: Readonly<Record<string, readonly string[]>>;
    },
  ): Promise<void>;
  softDelete(id: string, expectedVersion: number): Promise<void>;
}

export interface RecentSearchRecord {
  readonly query: string;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly searchedAt: Date;
}

export interface RecentSearchRepository {
  /**
   * Record one search, refreshing the row when the same query repeats, and prune the user's
   * list to the configured cap — both in the caller's transaction, so a search never half
   * records.
   */
  record(
    userId: UserId,
    entry: { readonly id: string } & RecentSearchRecord,
    keep: number,
  ): Promise<void>;
  listFor(userId: UserId, limit: number): Promise<readonly RecentSearchRecord[]>;
}

export type SearchRebuildStateKey = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface SearchRebuildRecord {
  readonly id: string;
  readonly state: SearchRebuildStateKey;
  readonly cursorDocumentId: string | null;
  readonly documentsIndexed: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly error: string | null;
}

export interface SearchRebuildRepository {
  findRunning(): Promise<SearchRebuildRecord | null>;
  /** The most recent run of any state — what an operator screen polls. */
  findLatest(): Promise<SearchRebuildRecord | null>;
  findById(id: string): Promise<SearchRebuildRecord | null>;
  /** Refused by `uq_search_rebuild_running` when one already runs — the database decides. */
  start(id: string, startedAt: Date): Promise<void>;
  advance(id: string, cursorDocumentId: string, documentsIndexed: number): Promise<void>;
  complete(id: string, completedAt: Date): Promise<void>;
  fail(id: string, completedAt: Date, error: string): Promise<void>;
}

/**
 * What the projection reads about one document — the read model's single source query.
 *
 * Declared here and implemented in this module's infrastructure as a reader over the source
 * tables. That is a recorded exception to "modules call each other's application services":
 * a projection's input is six modules' rows *as rows* — document, placement, organisation,
 * confidentiality, revision, approvals — and six bespoke bulk-read services invented for one
 * consumer would spread the read model's shape across six modules. The reader makes no
 * decision: the one decision in an index entry — who may see it — goes through `ACL_RESOLVER`,
 * and the text comes from Preview's own query service. See this module's README.
 */
export interface SearchSourceFacts {
  readonly document: {
    readonly id: DocumentId;
    readonly title: string;
    readonly description: string | null;
    readonly status: string;
    readonly documentNumber: string | null;
    readonly documentTypeId: string;
    readonly categoryId: string | null;
    readonly confidentialityRank: number;
    readonly ownerUserId: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly version: number;
  };
  readonly placement: {
    readonly libraryId: string;
    readonly folderId: string;
    readonly folderPath: string;
    readonly entityId: string | null;
    readonly departmentId: string | null;
    readonly branchId: string | null;
  };
  readonly revision: {
    readonly id: RevisionId;
    readonly ordinal: number;
    readonly label: string;
    readonly filename: string;
    readonly publishedAt: Date | null;
    readonly effectiveFrom: Date | null;
  } | null;
  /** Values keyed by field id; `searchableText` carries only fields marked searchable. */
  readonly metadata: {
    readonly values: Readonly<Record<string, unknown>>;
    readonly searchableText: string;
  };
  readonly approverIds: readonly string[];
}

export interface SearchSource {
  /** Null when the document does not exist or has stopped being findable (soft-deleted, purged). */
  factsFor(documentId: DocumentId): Promise<SearchSourceFacts | null>;
  /** Which document a revision belongs to — how a `preview.*` event finds its subject. */
  documentIdForRevision(revisionId: RevisionId): Promise<DocumentId | null>;
  /** Findable document ids in id order, after the cursor — the rebuild's enumeration. */
  findableIdsAfter(cursor: DocumentId | null, limit: number): Promise<readonly DocumentId[]>;
  /**
   * Findable document ids beneath one scope node, in id order, after the cursor.
   *
   * Phase 14's addition, and the answer to the phase's second risk. An ACL change high on the tree
   * changes the materialised `acl_subjects` of every entry beneath it, and a stale `acl_subjects`
   * is a search result somebody may not see — or one they should. This is the enumeration that
   * bounds a **targeted reprojection**: the same batching the rebuild uses, over a subtree rather
   * than over the tenant, so an entry on a folder costs that folder's documents rather than the
   * tenant's.
   */
  findableIdsUnderScope(
    scope: { readonly type: string; readonly id: string },
    cursor: DocumentId | null,
    limit: number,
  ): Promise<readonly DocumentId[]>;
  /** Resolve a `type:` field query's code to the type id, case-insensitively. */
  typeIdByCode(code: string): Promise<string | null>;
}

/** Keeps the index in step with its sources; coalesced per document, and safe to re-run. */
export interface SearchProjection {
  /** Projects the document's current truth — or removes the entry when it stopped being findable. */
  project(documentId: DocumentId): Promise<void>;
  remove(documentId: DocumentId): Promise<void>;
}

export const SEARCH_SERVICE = Symbol('SearchService');

export interface SearchRequest {
  /** The raw query text, field syntax and all; parsing is the service's. */
  readonly text: string | null;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly facets: readonly string[];
  readonly sort: 'RELEVANCE' | 'RECENT' | 'NUMBER' | 'TITLE';
  readonly cursor: string | null;
  readonly limit: number;
}

export interface SearchOutcome {
  readonly results: SearchResults;
  /** True when `search:all` widened this query past the caller's own reach — and was audited. */
  readonly unrestricted: boolean;
}

export interface SearchService {
  search(request: SearchRequest): Promise<SearchOutcome>;
}
