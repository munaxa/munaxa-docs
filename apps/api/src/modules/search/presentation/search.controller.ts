import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  SEARCH_FILTER_KEYS,
  createSavedSearchSchema,
  searchQuerySchema,
  updateSavedSearchSchema,
  type CreateSavedSearchBody,
  type RecentSearch,
  type SavedSearch,
  type SearchHit as WireSearchHit,
  type SearchQueryRequest,
  type SearchRebuild,
  type SearchResults as WireSearchResults,
  type UpdateSavedSearchBody,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { NotFoundError } from '../../../core/errors/application-errors';
import { AdministeredWriter } from '../../../core/persistence';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { IfMatch } from '../../../core/http/admin-request';
import type { SearchHit, SearchResults } from '../../../ports/search.port';
import {
  SEARCH_REBUILD_REPOSITORY,
  SEARCH_SERVICE,
  type RecentSearchRecord,
  type SavedSearchRecord,
  type SearchRebuildRecord,
  type SearchRebuildRepository,
  type SearchService,
} from '../application/ports';
import { SavedSearchService } from '../application/saved-search.service';
import { SearchRebuildService } from '../application/search-rebuild.service';

/**
 * The search surface (`docs/architecture/12-search-architecture.md` §§3, 5).
 *
 * `document:view` gates the whole surface: search is how a reader finds what they may read,
 * and everything narrower — which documents, which facets, which counts — is the predicate's
 * job inside the query, never this controller's. The rebuild is the one operator act here and
 * carries `settings:manage`, the tenant administrator's own gate.
 */
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(
    @Inject(SEARCH_SERVICE) private readonly search: SearchService,
    @Inject(SEARCH_REBUILD_REPOSITORY) private readonly rebuilds: SearchRebuildRepository,
    private readonly savedSearches: SavedSearchService,
    private readonly rebuildService: SearchRebuildService,
    private readonly writer: AdministeredWriter,
  ) {}

  @Get()
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async query(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQueryRequest,
  ): Promise<WireSearchResults> {
    const filters: Record<string, readonly string[]> = {};
    for (const key of SEARCH_FILTER_KEYS) {
      const value = query[key];
      if (value !== undefined) {
        filters[key] = [value];
      }
    }
    const outcome = await this.search.search({
      text: query.q ?? null,
      filters,
      facets: DEFAULT_FACETS,
      sort: SORT_KEYS[query.sort],
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    return toResults(outcome.results, outcome.unrestricted);
  }

  @Get('saved')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async listSaved(): Promise<{ data: SavedSearch[] }> {
    const records = await this.savedSearches.list();
    return { data: records.map(toSavedSearch) };
  }

  @Post('saved')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async createSaved(
    @Body(new ZodValidationPipe(createSavedSearchSchema)) body: CreateSavedSearchBody,
  ): Promise<SavedSearch> {
    return toSavedSearch(
      await this.savedSearches.create({
        name: body.name,
        query: body.query,
        filters: widen(body.filters),
      }),
    );
  }

  @Patch('saved/:id')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async updateSaved(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSavedSearchSchema)) body: UpdateSavedSearchBody,
    @IfMatch() version: number | undefined,
  ): Promise<SavedSearch> {
    return toSavedSearch(
      await this.savedSearches.update(id, version, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.query === undefined ? {} : { query: body.query }),
        ...(body.filters === undefined ? {} : { filters: widen(body.filters) }),
      }),
    );
  }

  @Delete('saved/:id')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  @HttpCode(204)
  async deleteSaved(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.savedSearches.remove(id, version);
  }

  @Get('recent')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async listRecent(): Promise<{ data: RecentSearch[] }> {
    const records = await this.savedSearches.recent();
    return { data: records.map(toRecentSearch) };
  }

  /** The operator act: audited, queued, resumable. 202 — the work happens in the lane. */
  @Post('rebuild')
  @RequirePermission(Permission.SETTINGS_MANAGE)
  @HttpCode(202)
  async requestRebuild(): Promise<SearchRebuild> {
    return toRebuild(await this.rebuildService.request());
  }

  @Get('rebuild')
  @RequirePermission(Permission.SETTINGS_MANAGE)
  async rebuildStatus(): Promise<SearchRebuild> {
    const latest = await this.writer.read(() => this.rebuilds.findLatest());
    if (latest === null) {
      throw new NotFoundError('The requested resource');
    }
    return toRebuild(latest);
  }
}

const DEFAULT_FACETS = ['status', 'type', 'category', 'department', 'entity', 'year'] as const;

const SORT_KEYS = {
  relevance: 'RELEVANCE',
  recent: 'RECENT',
  number: 'NUMBER',
  title: 'TITLE',
} as const;

function toResults(results: SearchResults, unrestricted: boolean): WireSearchResults {
  return {
    data: results.hits.map(toHit),
    meta: { total: results.total, unrestricted },
    facets: Object.fromEntries(
      Object.entries(results.facets).map(([facet, buckets]) => [
        facet,
        buckets.map((bucket) => ({ value: bucket.value, count: bucket.count })),
      ]),
    ),
    nextCursor: results.nextCursor,
  };
}

function toHit(hit: SearchHit): WireSearchHit {
  return {
    documentId: hit.documentId,
    score: hit.score,
    title: hit.summary.title,
    documentNumber: hit.summary.documentNumber,
    status: hit.summary.status,
    documentTypeId: hit.summary.documentTypeId,
    categoryId: hit.summary.categoryId,
    libraryId: hit.summary.libraryId,
    folderId: hit.summary.folderId,
    ownerId: hit.summary.ownerId,
    filename: hit.summary.filename,
    revisionOrdinal: hit.summary.revisionOrdinal,
    revisionLabel: hit.summary.revisionLabel,
    language: hit.summary.language,
    bodySource: hit.summary.bodySource,
    contentPending: hit.summary.contentPending,
    lowConfidence: hit.summary.lowConfidence,
    confidentialityRank: hit.summary.confidentialityRank,
    updatedAt: hit.summary.updatedAt.toISOString(),
    publishedAt: hit.summary.publishedAt?.toISOString() ?? null,
    effectiveFrom: hit.summary.effectiveFrom?.toISOString().slice(0, 10) ?? null,
    highlights: Object.fromEntries(
      Object.entries(hit.highlights).map(([field, fragments]) => [
        field,
        fragments.map((fragment) => fragment.map((span) => ({ text: span.text, hit: span.hit }))),
      ]),
    ),
  };
}

function toSavedSearch(record: SavedSearchRecord): SavedSearch {
  return {
    id: record.id,
    name: record.name,
    query: record.query,
    filters: narrow(record.filters),
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
  };
}

function toRecentSearch(record: RecentSearchRecord): RecentSearch {
  return {
    query: record.query,
    filters: narrow(record.filters),
    searchedAt: record.searchedAt.toISOString(),
  };
}

function toRebuild(record: SearchRebuildRecord): SearchRebuild {
  return {
    id: record.id,
    state: record.state,
    documentsIndexed: record.documentsIndexed,
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    error: record.error,
  };
}

/** The wire's one-value-per-key filters, widened to the engine's array shape. */
function widen(filters: Readonly<Record<string, string>>): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, [value]]));
}

/** Stored arrays, narrowed back to the wire's one-value-per-key shape. */
function narrow(filters: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  const narrowed: Record<string, string> = {};
  for (const [key, values] of Object.entries(filters)) {
    const first = values[0];
    if (first !== undefined) {
      narrowed[key] = first;
    }
  }
  return narrowed;
}
