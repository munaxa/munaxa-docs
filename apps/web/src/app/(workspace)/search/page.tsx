import type { ReactNode } from 'react';

import type { RecentSearch, SavedSearch, SearchResults } from '@edms/contracts';
import { SEARCH_FILTER_KEYS } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import { SearchScreen } from '../../../features/search/search-screen';
import { adminAccess, adminGet } from '../../../lib/admin/api';

type RawSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * The search screen (`16-frontend-architecture.md` §5): query bar with field syntax, facet
 * rail, keyset "load more", saved searches.
 *
 * The URL is the entire input — query, sort, filters, cursor — so a filtered search is a link
 * somebody sends to a colleague, exactly as every list in this product. The first page of
 * results is fetched here on the server; "load more" continues through a server action, so
 * the token never leaves its cookie either way.
 *
 * An empty URL runs nothing: the screen opens on the person's own saved and recent searches
 * rather than on page one of everything, because "every document, unranked" is not an answer
 * to a question nobody asked yet.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.DOCUMENT_VIEW);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    const resolved = typeof value === 'string' ? value : value?.[0];
    return typeof resolved === 'string' && resolved.trim() !== '' ? resolved.trim() : undefined;
  };

  const queryText = single('q') ?? '';
  const sort = single('sort') ?? 'relevance';
  const filters: Record<string, string> = {};
  for (const key of SEARCH_FILTER_KEYS) {
    const value = single(key);
    if (value !== undefined) {
      filters[key] = value;
    }
  }

  const shouldSearch = queryText !== '' || Object.keys(filters).length > 0;

  /**
   * The whole of it — Slices 10 and 11.
   *
   * Three reads, and a refusal from any of them still throws: without results there is nothing to
   * show, and an error boundary is the honest answer. All three carry `document:view`, the same key
   * this page gated on above, so a caller who got past the gate can reach all three.
   *
   * Four more used to share this `Promise.all`, fetching the tenant's document types, categories,
   * departments and entities to caption the facets. Every one sat behind `settings:manage` or
   * `org:manage`, so all four answered 403 for the seeded document controller and auditor, one
   * rejection discarded the render, and `/search` was the route error boundary for two of the three
   * roles that can open it. Measured on the running stack, not inferred.
   *
   * Slice 10 made them conditional and optional. Slice 11 removed them: the names come back with
   * the results, resolved server-side for the facet values the ACL predicate had already counted.
   * The list above is now the complete set of requests this page makes.
   */
  const [results, saved, recent] = await Promise.all([
    shouldSearch
      ? adminGet<SearchResults>(`/search?${searchQueryString(queryText, sort, filters)}`)
      : Promise.resolve(null),
    adminGet<{ data: SavedSearch[] }>('/search/saved'),
    adminGet<{ data: RecentSearch[] }>('/search/recent'),
  ]);

  return (
    <SearchScreen
      // Keyed by the whole query, so a new search resets the accumulated pages.
      key={`${queryText}|${sort}|${JSON.stringify(filters)}`}
      queryText={queryText}
      sort={sort}
      filters={filters}
      initialResults={results}
      saved={saved.data}
      recent={recent.data}
      typeLabels={labelsFrom(results, 'type')}
      categoryLabels={labelsFrom(results, 'category')}
      departmentLabels={labelsFrom(results, 'department')}
      entityLabels={labelsFrom(results, 'entity')}
    />
  );
}

/**
 * The names the search response already carries, in the shape the screen takes — Slice 11.
 *
 * ## Why there is nothing to fetch here any more
 *
 * There used to be. `/search` read the tenant's document types, categories, departments and
 * entities to caption its facets, and every one of those sits behind `settings:manage` or
 * `org:manage` — so the workspace was the route error boundary for the two seeded roles that hold
 * neither. Slice 10 made the four reads optional and conditional, which fixed the page and left
 * the auditor reading raw identifiers.
 *
 * The server answers it properly now. `SearchService` resolves names for the facet values it just
 * counted **inside the ACL predicate**, so the labels arrive with the results, restricted to
 * exactly what the caller was already shown. Every role gets the same captions, and the page asks
 * for nothing to get them.
 *
 * ## Why this is a projection and not a lookup
 *
 * It reads `bucket.label` out of the response and keys it by `bucket.value`. There is no request,
 * no catalogue and no second source of truth — the screen's existing `labels?.[value] ?? value`
 * fallback still covers a bucket the server could not name, which is now the only way a raw value
 * reaches the eye.
 *
 * The maps are per facet because that is the shape `SearchScreen` has always taken; keeping it
 * means this slice changes no component, no markup and no baseline.
 */
function labelsFrom(
  results: SearchResults | null,
  facet: string,
): Readonly<Record<string, string>> {
  const buckets = results?.facets[facet] ?? [];
  return Object.fromEntries(
    buckets
      .filter((bucket) => bucket.label !== undefined)
      .map((bucket) => [bucket.value, bucket.label as string]),
  );
}

function searchQueryString(
  queryText: string,
  sort: string,
  filters: Readonly<Record<string, string>>,
): string {
  const query = new URLSearchParams();
  if (queryText !== '') {
    query.set('q', queryText);
  }
  query.set('sort', sort);
  for (const [key, value] of Object.entries(filters)) {
    query.set(key, value);
  }
  return query.toString();
}
