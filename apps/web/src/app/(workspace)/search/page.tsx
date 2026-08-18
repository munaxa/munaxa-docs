import type { ReactNode } from 'react';

import type {
  CategoryOption,
  Collection,
  DepartmentOption,
  DocumentTypeOption,
  Entity,
  RecentSearch,
  SavedSearch,
  SearchResults,
} from '@edms/contracts';
import { SEARCH_FILTER_KEYS } from '@edms/contracts';
import { Permission, type PermissionKey } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import { SearchScreen } from '../../../features/search/search-screen';
import { adminAccess, adminGet, adminRead } from '../../../lib/admin/api';
import { listQueryString } from '../../../lib/admin/list-state';

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
   * The workspace itself — Slice 10.
   *
   * Three reads, and a refusal from any of them still throws: without results there is nothing to
   * show, and an error boundary is the honest answer. All three carry `document:view`, the same
   * key this page gated on above, so a caller who got past the gate can reach all three.
   *
   * The four label reads used to share this `Promise.all`, and that is the whole defect. They are
   * behind `settings:manage` and `org:manage` — keys the seeded document controller and auditor do
   * not hold — so all four answered 403, one rejection discarded the render, and `/search` was the
   * route error boundary for two of the three roles that can open it. Measured on the running
   * stack, not inferred: only a tenant administrator could search at all.
   */
  const [results, saved, recent] = await Promise.all([
    shouldSearch
      ? adminGet<SearchResults>(`/search?${searchQueryString(queryText, sort, filters)}`)
      : Promise.resolve(null),
    adminGet<{ data: SavedSearch[] }>('/search/saved'),
    adminGet<{ data: RecentSearch[] }>('/search/recent'),
  ]);

  const labels = await facetLabels(results, access.permissions);

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
      typeLabels={labels.type}
      categoryLabels={labels.category}
      departmentLabels={labels.department}
      entityLabels={labels.entity}
    />
  );
}

/** One id-to-name map per facet that has names. Empty is a valid answer for every one of them. */
interface FacetLabels {
  readonly type: Readonly<Record<string, string>>;
  readonly category: Readonly<Record<string, string>>;
  readonly department: Readonly<Record<string, string>>;
  readonly entity: Readonly<Record<string, string>>;
}

const NO_LABELS: Readonly<Record<string, string>> = {};
const NOTHING_TO_LABEL: FacetLabels = {
  type: NO_LABELS,
  category: NO_LABELS,
  department: NO_LABELS,
  entity: NO_LABELS,
};

/**
 * The names behind the facet values — presentation, and never the page.
 *
 * ## Why these are a second tier rather than four more entries in the `Promise.all`
 *
 * Because of what they are for. `facetLabel` in `search-screen.tsx` ends `labels?.[value] ?? value`
 * and `ResultCard` renders its type chip only `{typeLabel !== undefined && …}` — the screen has
 * always been able to draw itself without a single one of these. They decide whether a facet reads
 * `Quality Manual` or a UUID, and a page that refuses to render because it could not resolve a
 * caption is a page with its priorities inverted.
 *
 * Sharing the render-critical `Promise.all` made that inversion structural: one 403 from a label
 * read rejected the whole thing. Splitting the graph is what removes it, and it is deliberately a
 * split rather than a `try`/`catch` around the original — a catch would have swallowed a failed
 * *search* just as readily.
 *
 * ## Three conditions, and each is a different question
 *
 * **Did a search run?** No search, no facets and no result cards, so nothing to label. This is the
 * landing page, and it now reads nothing at all.
 *
 * **Is this facet on screen?** A search whose results carry no `department` bucket has no use for
 * the department names. Asked per dataset rather than once, because the facets a query produces
 * differ by query.
 *
 * **May this caller read it?** The same capability question `/documents` asks, from the same
 * `access.permissions` — "cannot use it, so do not ask for it". The seeded auditor holds none of
 * these keys and now issues no label request at all rather than four refused ones.
 *
 * ## Why a refusal still degrades rather than throws
 *
 * The capability check means a refusal should not happen. `permission_version` makes it possible
 * anyway: a role edit lands in the database while an outstanding access token still carries the
 * grants it was minted with, so for up to `JWT_ACCESS_TTL_SECONDS` a caller can believe it holds a
 * key the API has already taken away. `adminRead` is the repository's own answer to a read whose
 * failure is a *result* — it redirects an expired session to `/login` and otherwise reports the
 * code — so that window costs a caption rather than the workspace.
 *
 * This is not hiding an authorization failure: nothing is fabricated, the endpoint is untouched,
 * the guard still decides, and the facet shows the raw value it always falls back to.
 *
 * ## Why entities are still read administratively
 *
 * There is no operational read model for them, and this slice does not add one. `/admin/entities`
 * keeps `org:manage` and is asked for only by a caller who holds it, so a tenant administrator
 * keeps the entity names it has always had and nobody else gains a byte. The endpoint returns
 * `legalName`, the department and branch counts and the owning company alongside the two fields
 * used here, which is why widening it was never the answer — the right fix is for the search
 * response to carry its own bucket labels, and that is an API change and a later slice.
 */
async function facetLabels(
  results: SearchResults | null,
  permissions: readonly PermissionKey[],
): Promise<FacetLabels> {
  if (results === null) {
    return NOTHING_TO_LABEL;
  }

  const holds = (permission: PermissionKey): boolean => permissions.includes(permission);
  const bucketed = (facet: string): boolean => (results.facets[facet]?.length ?? 0) > 0;
  const canRead = holds(Permission.CONFIGURATION_VIEW);

  const [type, category, department, entity] = await Promise.all([
    // Types name the chip on every result card as well as their own facet, so they are worth
    // resolving whenever there is anything on screen at all. No `isActive` filter: a document
    // filed under a since-retired type is still a result, and its type still has a name.
    canRead && (results.data.length > 0 || bucketed('type'))
      ? namesFrom<DocumentTypeOption>('/configuration/document-types', 'name')
      : NO_LABELS,
    canRead && bucketed('category')
      ? namesFrom<CategoryOption>('/configuration/categories', 'path')
      : NO_LABELS,
    holds(Permission.DIRECTORY_VIEW) && bucketed('department')
      ? namesFrom<DepartmentOption>('/directory/departments', 'path')
      : NO_LABELS,
    holds(Permission.ORG_MANAGE) && bucketed('entity')
      ? namesFrom<Entity>('/admin/entities', 'name')
      : NO_LABELS,
  ]);

  return { type, category, department, entity };
}

/**
 * One page of a list, as an id-to-name map, and an empty map when it could not be read.
 *
 * `adminRead` rather than `adminOptions`, which is the whole point: `adminOptions` throws, and a
 * caption is not worth a screen. The query is the one `adminOptions` builds — the API's maximum
 * page, ascending, live rows only — so the request on the wire is unchanged from the caller's side.
 */
async function namesFrom<TItem extends { readonly id: string; readonly name: string }>(
  path: string,
  sortBy: string,
): Promise<Readonly<Record<string, string>>> {
  const page = await adminRead<Collection<TItem>>(
    `${path}${listQueryString({
      page: 1,
      pageSize: 100,
      sortBy,
      sortDirection: 'asc',
      search: '',
      deleted: 'live',
      filters: {},
    })}`,
  );
  return page.ok
    ? Object.fromEntries(page.value.data.map((item) => [item.id, item.name]))
    : NO_LABELS;
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
