import type { ReactNode } from 'react';

import type {
  Category,
  Department,
  DocumentType,
  Entity,
  RecentSearch,
  SavedSearch,
  SearchResults,
} from '@edms/contracts';
import { SEARCH_FILTER_KEYS } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import { SearchScreen } from '../../../features/search/search-screen';
import { adminAccess, adminGet, adminOptions } from '../../../lib/admin/api';

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

  const [results, saved, recent, types, categories, departments, entities] = await Promise.all([
    shouldSearch
      ? adminGet<SearchResults>(`/search?${searchQueryString(queryText, sort, filters)}`)
      : Promise.resolve(null),
    adminGet<{ data: SavedSearch[] }>('/search/saved'),
    adminGet<{ data: RecentSearch[] }>('/search/recent'),
    adminOptions<DocumentType>('/admin/document-types', 'name'),
    adminOptions<Category>('/admin/categories', 'path'),
    adminOptions<Department>('/admin/departments', 'path'),
    adminOptions<Entity>('/admin/entities', 'name'),
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
      typeLabels={Object.fromEntries(types.data.map((type) => [type.id, type.name]))}
      categoryLabels={Object.fromEntries(
        categories.data.map((category) => [category.id, category.name]),
      )}
      departmentLabels={Object.fromEntries(
        departments.data.map((department) => [department.id, department.name]),
      )}
      entityLabels={Object.fromEntries(entities.data.map((entity) => [entity.id, entity.name]))}
    />
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
