import { Module } from '@nestjs/common';

import { PreviewModule } from '../preview/preview.module';
import {
  RECENT_SEARCH_REPOSITORY,
  SAVED_SEARCH_REPOSITORY,
  SEARCH_PROJECTION,
  SEARCH_REBUILD_REPOSITORY,
  SEARCH_SERVICE,
  SEARCH_SOURCE,
} from './application/ports';
import { DefaultSearchService } from './application/search.service';
import { SavedSearchService } from './application/saved-search.service';
import { SearchProjectionService } from './application/search-projection.service';
import { SearchRebuildService } from './application/search-rebuild.service';
import { PrismaSearchSourceReader } from './infrastructure/prisma-search-source.reader';
import {
  PrismaRecentSearchRepository,
  PrismaSavedSearchRepository,
  PrismaSearchRebuildRepository,
} from './infrastructure/prisma-search.repositories';
import { SearchIndexConsumer } from './infrastructure/search-index.consumer';
import { SearchController } from './presentation/search.controller';

/**
 * Search — How is it found?
 *
 * **Owns:** The index projection, query, permission filtering, saved searches
 * **Depends on:** Document, Preview, Library (through `ACL_RESOLVER`)
 *
 * `SEARCH_PORT` and `INDEX_PORT` are bound in core, underneath `TenantScopedSearch` — the
 * isolation wrapper Phase 2.5 built and this phase deliberately leaves alone. What this module
 * adds is everything above and beside the engine: the projection that keeps the index equal to
 * its sources, the consumer that finally drains the `search.index` lane Phase 0.5 declared and
 * Phase 7 filled, the query service that pushes the ACL predicate into the engine before
 * scoring, the rebuild, and the saved and recent searches.
 *
 * `PreviewModule` is imported for its query service — extracted text is the preview pipeline's
 * own read side, consumed the way Document and Revision already consume it. The consumer is
 * registered here, in the module that owns the use case, exactly as Preview and Workflow
 * register theirs.
 */
@Module({
  imports: [PreviewModule],
  controllers: [SearchController],
  providers: [
    { provide: SEARCH_SOURCE, useClass: PrismaSearchSourceReader },
    { provide: SAVED_SEARCH_REPOSITORY, useClass: PrismaSavedSearchRepository },
    { provide: RECENT_SEARCH_REPOSITORY, useClass: PrismaRecentSearchRepository },
    { provide: SEARCH_REBUILD_REPOSITORY, useClass: PrismaSearchRebuildRepository },
    SearchProjectionService,
    { provide: SEARCH_PROJECTION, useExisting: SearchProjectionService },
    { provide: SEARCH_SERVICE, useClass: DefaultSearchService },
    SavedSearchService,
    SearchRebuildService,
    SearchIndexConsumer,
  ],
  exports: [SEARCH_SERVICE],
})
export class SearchModule {}
