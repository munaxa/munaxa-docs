import { Inject, Injectable } from '@nestjs/common';

import { NotFoundError } from '../../core/errors/application-errors';
import { requireContext } from '../../core/tenancy/tenant-context';
import { TENANT_REGISTRY, type TenantRegistry } from '../../core/tenancy/tenant-registry.port';
import type {
  SearchPort,
  SearchQuery,
  SearchResults,
  SearchSubject,
} from '../../ports/search.port';

/**
 * A search engine that has been told which index to use.
 *
 * The port a use case sees has no index in its signature, because which index answers a tenant's search
 * is not a use-case decision — it is a placement. So the adapters are written against *this* interface
 * instead, and receive the index from the layer above them. An adapter therefore cannot forget to scope
 * a query: it has no way to run one without being told where
 * ([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 *
 * For the PostgreSQL-backed first generation the index is a schema or a table prefix inside the
 * tenant's own database, so isolation is already physical and this is belt on top of braces. For an
 * external engine it is the whole of the isolation, because one OpenSearch cluster serving every tenant
 * has nothing but the index name keeping them apart.
 */
export const PLACED_SEARCH_PORT = Symbol('PlacedSearchPort');

export interface PlacedSearchPort {
  query(index: string, subject: SearchSubject, query: SearchQuery): Promise<SearchResults>;
}

/**
 * The search port, with the subject and the index taken from the ambient tenant.
 *
 * `SearchSubject` carries a `tenantId`, and that field is **overwritten** here rather than trusted. A
 * caller that constructed a subject for another tenant — by mistake, or because a parameter was
 * threaded through from a request body — gets its own tenant's results, not a leak. The permission
 * fingerprints in `subjectIds` are still the caller's, because those are what filter *within* a tenant
 * and the engine needs them before scoring.
 */
@Injectable()
export class TenantScopedSearch implements SearchPort {
  constructor(
    @Inject(PLACED_SEARCH_PORT) private readonly inner: PlacedSearchPort,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  async query(subject: SearchSubject, query: SearchQuery): Promise<SearchResults> {
    const { tenantId } = requireContext();
    const placement = await this.registry.byId(tenantId);
    if (!placement) {
      throw new NotFoundError('The requested resource');
    }
    return this.inner.query(placement.search.index, { ...subject, tenantId }, query);
  }
}
