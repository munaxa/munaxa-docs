import type { AnyId, DocumentId, TenantId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Full-text and metadata search.
 *
 * PostgreSQL carries the first generation behind this port; an external engine replaces the
 * adapter without touching a use case
 * (`docs/architecture/adr/0008-postgres-first-search.md`).
 *
 * The port takes the caller's permission fingerprint because results must be filtered
 * *before* scoring — fetch-then-filter leaks totals, facet counts and page boundaries.
 */
export const SEARCH_PORT = Symbol('SearchPort');

export interface SearchSubject {
  readonly tenantId: TenantId;
  /** User, role and department ids the index is filtered against. */
  readonly subjectIds: readonly AnyId[];
}

export interface SearchQuery {
  readonly text: string | null;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly facets: readonly string[];
  readonly page: PageRequest;
}

export interface SearchHit {
  readonly documentId: DocumentId;
  readonly score: number;
  /** Field name to matched fragments, already escaped for display. */
  readonly highlights: Readonly<Record<string, readonly string[]>>;
}

export interface FacetBucket {
  readonly value: string;
  readonly count: number;
}

export interface SearchResults extends Page<SearchHit> {
  readonly facets: Readonly<Record<string, readonly FacetBucket[]>>;
}

/** What the projection writes; rebuildable from source at any time, never authoritative. */
export interface IndexDocument {
  readonly documentId: DocumentId;
  readonly tenantId: TenantId;
  readonly title: string;
  readonly documentNumber: string | null;
  readonly body: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  /** Fingerprint of the resolved ACL, so a permission change invalidates the entry. */
  readonly aclHash: string;
  readonly language: string;
}

export interface SearchPort {
  query(subject: SearchSubject, query: SearchQuery): Promise<SearchResults>;
}

export const INDEX_PORT = Symbol('IndexPort');

export interface IndexPort {
  upsert(document: IndexDocument): Promise<void>;
  remove(documentId: DocumentId): Promise<void>;
  /** Used by a rebuild, which must be safe to run on a live index. */
  bulkUpsert(documents: readonly IndexDocument[]): Promise<void>;
}
