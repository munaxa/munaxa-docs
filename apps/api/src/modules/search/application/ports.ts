import type { DocumentId, UserId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * The index is a read model: rebuildable from source at any time, never authoritative
 * (`docs/architecture/adr/0008-postgres-first-search.md`).
 *
 * Results are filtered by permission **before** scoring. Fetch-then-filter leaks totals,
 * facet counts and page boundaries, which is enough to enumerate a library a user cannot read.
 */
export const SAVED_SEARCH_REPOSITORY = Symbol('SavedSearchRepository');
export const SEARCH_PROJECTION = Symbol('SearchProjection');

export interface SavedSearchRecord {
  readonly id: string;
  readonly ownerId: UserId;
  readonly name: string;
  readonly query: string;
  readonly filters: Readonly<Record<string, readonly string[]>>;
}

export interface SavedSearchRepository {
  findById(id: string): Promise<SavedSearchRecord | null>;
  listFor(ownerId: UserId, page: PageRequest): Promise<Page<SavedSearchRecord>>;
  save(search: SavedSearchRecord): Promise<void>;
}

/** Keeps the index in step with its sources; coalesced per document, and safe to re-run. */
export interface SearchProjection {
  project(documentId: DocumentId): Promise<void>;
  remove(documentId: DocumentId): Promise<void>;
  /** A full rebuild must be safe to run against a live index. */
  rebuild(batchSize: number): Promise<number>;
}

export const SEARCH_SERVICE = Symbol('SearchService');

export interface SearchService {
  search(input: {
    userId: UserId;
    text: string | null;
    filters: Readonly<Record<string, readonly string[]>>;
    page: PageRequest;
  }): Promise<Page<{ documentId: DocumentId; score: number }>>;
}
