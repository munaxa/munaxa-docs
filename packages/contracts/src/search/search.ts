import { z } from 'zod';

import { searchTermSchema } from '../common/query';

/**
 * Phase 8 — the search surface (`docs/architecture/12-search-architecture.md`).
 *
 * Three shapes worth noticing. Pagination is a **keyset cursor**, not a page number: search
 * results shift under concurrent writes and degrade at offset depth, so the API hands back an
 * opaque `nextCursor` and the client asks for "after this", never "page seven". Highlights are
 * **segmented spans**, not markup: the server says which characters matched and the client
 * renders them, because a string of server-authored HTML in a search result is an injection
 * looking for a renderer. And `contentPending` is honesty on the wire: a document whose text
 * extraction has not finished is findable by number, title and metadata, and *says* its
 * content is still being indexed rather than pretending it has none
 * (`12-search-architecture.md` §4).
 */

/** The filters a search accepts beside the query text — one value each on the wire; the
 *  query syntax (`status:X status:Y`) is how a caller says "or". */
export const SEARCH_FILTER_KEYS = [
  'status',
  'type',
  'category',
  'department',
  'entity',
  'branch',
  'folder',
  'owner',
  'approver',
  'number',
  'language',
  'confidentiality',
  'updated',
  'published',
  'created',
  'effective',
] as const;

export type SearchFilterKey = (typeof SEARCH_FILTER_KEYS)[number];

export const searchSortSchema = z.enum(['relevance', 'recent', 'number', 'title']);

export type SearchSort = z.infer<typeof searchSortSchema>;

const filterValueSchema = z.string().trim().min(1).max(200);

export const searchQuerySchema = z.object({
  q: searchTermSchema.max(500).optional(),
  sort: searchSortSchema.default('relevance'),
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  // The filter keys, spelled out so the inferred type names every one.
  status: filterValueSchema.optional(),
  type: filterValueSchema.optional(),
  category: filterValueSchema.optional(),
  department: filterValueSchema.optional(),
  entity: filterValueSchema.optional(),
  branch: filterValueSchema.optional(),
  folder: filterValueSchema.optional(),
  owner: filterValueSchema.optional(),
  approver: filterValueSchema.optional(),
  number: filterValueSchema.optional(),
  language: filterValueSchema.optional(),
  confidentiality: filterValueSchema.optional(),
  updated: filterValueSchema.optional(),
  published: filterValueSchema.optional(),
  created: filterValueSchema.optional(),
  effective: filterValueSchema.optional(),
});

export type SearchQueryRequest = z.infer<typeof searchQuerySchema>;

export const highlightSpanSchema = z.object({
  text: z.string(),
  hit: z.boolean(),
});

export type HighlightSpan = z.infer<typeof highlightSpanSchema>;

export const searchHitSchema = z.object({
  documentId: z.string().uuid(),
  score: z.number(),
  title: z.string(),
  documentNumber: z.string().nullable(),
  status: z.string(),
  documentTypeId: z.string().uuid(),
  categoryId: z.string().uuid().nullable(),
  libraryId: z.string().uuid(),
  folderId: z.string().uuid(),
  ownerId: z.string().uuid(),
  filename: z.string().nullable(),
  revisionOrdinal: z.number().int().nullable(),
  revisionLabel: z.string().nullable(),
  language: z.string(),
  /** Null when no extracted text is indexed; `OCR` marks an inference, not the file's words. */
  bodySource: z.enum(['TEXT', 'OCR']).nullable(),
  contentPending: z.boolean(),
  lowConfidence: z.boolean(),
  confidentialityRank: z.number().int(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  highlights: z.record(z.array(z.array(highlightSpanSchema))),
});

export type SearchHit = z.infer<typeof searchHitSchema>;

export const facetBucketSchema = z.object({
  value: z.string(),
  count: z.number().int(),
  /**
   * What to show instead of the value — Slice 11, and optional for two different reasons.
   *
   * **Additive.** `value` is the filter and stays exactly what it was; this is presentation beside
   * it. A client that ignores the field behaves as it always did, which is why it is a new optional
   * property rather than a change to `value`.
   *
   * **Sometimes there genuinely is no name.** A `status` or a `year` bucket is its own label and
   * the catalogue translates it; a type, category, department or entity whose row has since been
   * deleted has no name left to give. Both cases arrive as an absent `label`, and the client falls
   * back to the value it already had.
   *
   * The security property is in *where* it comes from: the server resolves names only for the
   * values already present in the caller's own ACL-filtered facet result. A bucket the caller
   * cannot see has no label here because it has no bucket here.
   */
  label: z.string().optional(),
});

export type FacetBucket = z.infer<typeof facetBucketSchema>;

export const searchResultsSchema = z.object({
  data: z.array(searchHitSchema),
  meta: z.object({
    /** Post-filter — safe to show, because the permission predicate already ran. */
    total: z.number().int(),
    /** True when `search:all` widened this query past the caller's own reach (audited). */
    unrestricted: z.boolean(),
  }),
  facets: z.record(z.array(facetBucketSchema)),
  nextCursor: z.string().nullable(),
});

export type SearchResults = z.infer<typeof searchResultsSchema>;

/** Saved-search filters travel exactly as the query string sends them: one value per key. */
export const savedSearchFiltersSchema = z.record(z.enum(SEARCH_FILTER_KEYS), filterValueSchema);

export const savedSearchSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  query: z.string(),
  filters: savedSearchFiltersSchema,
  updatedAt: z.string(),
  version: z.number().int(),
});

export type SavedSearch = z.infer<typeof savedSearchSchema>;

export const createSavedSearchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().max(500).default(''),
  filters: savedSearchFiltersSchema.default({}),
});

export type CreateSavedSearchBody = z.infer<typeof createSavedSearchSchema>;

export const updateSavedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    query: z.string().trim().max(500).optional(),
    filters: savedSearchFiltersSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change.' });

export type UpdateSavedSearchBody = z.infer<typeof updateSavedSearchSchema>;

export const recentSearchSchema = z.object({
  query: z.string(),
  filters: savedSearchFiltersSchema,
  searchedAt: z.string(),
});

export type RecentSearch = z.infer<typeof recentSearchSchema>;

export const searchRebuildSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(['RUNNING', 'COMPLETED', 'FAILED']),
  documentsIndexed: z.number().int(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export type SearchRebuild = z.infer<typeof searchRebuildSchema>;
