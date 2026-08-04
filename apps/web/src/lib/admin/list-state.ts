import type { DeletedFilter, SortDirection } from '@edms/contracts';
// The narrow entry point, not the barrel: this module is reached from a client component, and
// `@edms/utils`' root export pulls in `node:crypto` through its identifier generator.
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@edms/utils/pagination';

/**
 * The state of an administration list, held in the URL.
 *
 * Every list in Administration is paged, sorted, searched and filtered, and all four live in the
 * query string rather than in component state. That is not a preference: a filtered list is
 * something an administrator sends to a colleague, and a page that keeps its filters in a `useState`
 * answers a shared link with the unfiltered list
 * (`docs/architecture/16-frontend-architecture.md` §3).
 *
 * The consequence worth stating is that the *server* fetches the page. The URL is a request, the
 * server component reads it, and the grid renders what came back — so the first paint is the right
 * page rather than an empty grid that fills in.
 */
export interface ListState {
  /** 1-based, like the API's. */
  readonly page: number;
  readonly pageSize: number;
  /** Null means the endpoint's own default order. */
  readonly sortBy: string | null;
  readonly sortDirection: SortDirection;
  readonly search: string;
  readonly deleted: DeletedFilter;
  /**
   * Resource-specific filters — `entityId` on branches, `dataType` on fields.
   *
   * A flat string map rather than a typed union per resource: these are query parameters on both
   * sides of the call, the API validates each one against its own schema, and a client-side type
   * would only be a second, weaker copy of that check.
   */
  readonly filters: Readonly<Record<string, string>>;
}

/** What Next hands a page as `searchParams`, before anything has been decided about it. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

const DELETED_FILTERS: readonly DeletedFilter[] = ['live', 'deleted', 'all'];

/** Keys `ListState` owns; anything else in the query string is a resource filter. */
const RESERVED = new Set(['page', 'pageSize', 'sortBy', 'sortDirection', 'search', 'deleted']);

/**
 * Reads a list's state out of the URL.
 *
 * Every value is bounded here rather than trusted, because these arrive from a query string a user
 * can type. An out-of-range page becomes the first page rather than an error: a stale link is a
 * normal thing to follow, and answering it with a failure screen teaches nothing.
 *
 * `sortable` is the allow-list the endpoint published. A sort field outside it is dropped, so the
 * API is never asked to sort by a column it would refuse — the same allow-list, applied twice, for
 * the same reason it is allow-listed at all.
 */
export function readListState(
  params: RawSearchParams,
  sortable: readonly string[],
  filterKeys: readonly string[] = [],
): ListState {
  const sortBy = single(params.sortBy);
  const deleted = single(params.deleted);
  const allowedFilters = new Set(filterKeys);

  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED.has(key) || !allowedFilters.has(key)) {
      continue;
    }
    const resolved = single(value);
    if (resolved !== undefined && resolved !== '') {
      filters[key] = resolved;
    }
  }

  return {
    page: boundedInteger(single(params.page), 1, Number.MAX_SAFE_INTEGER, 1),
    pageSize: boundedInteger(single(params.pageSize), 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
    sortBy: sortBy !== undefined && sortable.includes(sortBy) ? sortBy : null,
    sortDirection: single(params.sortDirection) === 'asc' ? 'asc' : 'desc',
    search: (single(params.search) ?? '').trim().slice(0, 200),
    deleted: DELETED_FILTERS.find((candidate) => candidate === deleted) ?? 'live',
    filters,
  };
}

/**
 * The query string for the API call.
 *
 * Defaults are omitted, so a canonical list has a clean URL — and so a reader comparing two links
 * can see what actually differs between them.
 */
export function listQueryString(state: ListState): string {
  const params = new URLSearchParams();
  if (state.page !== 1) {
    params.set('page', String(state.page));
  }
  if (state.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set('pageSize', String(state.pageSize));
  }
  if (state.sortBy !== null) {
    params.set('sortBy', state.sortBy);
    params.set('sortDirection', state.sortDirection);
  }
  if (state.search !== '') {
    params.set('search', state.search);
  }
  if (state.deleted !== 'live') {
    params.set('deleted', state.deleted);
  }
  for (const [key, value] of Object.entries(state.filters)) {
    params.set(key, value);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * Applies a change and returns the next state.
 *
 * Anything that changes *which* rows match resets to the first page. Staying on page four of a
 * result set that now has two pages shows an empty grid, and an empty grid is indistinguishable
 * from "nothing matches" — which is the one thing it does not mean.
 */
export function withChange(state: ListState, change: Partial<ListState>): ListState {
  const narrows =
    change.search !== undefined ||
    change.deleted !== undefined ||
    change.filters !== undefined ||
    change.pageSize !== undefined;

  return {
    ...state,
    ...change,
    ...(narrows && change.page === undefined && { page: 1 }),
  };
}

/** Replaces one resource filter. An empty value clears it rather than filtering on `''`. */
export function withFilter(state: ListState, key: string, value: string): ListState {
  const filters = { ...state.filters };
  if (value === '') {
    delete filters[key];
  } else {
    filters[key] = value;
  }
  return withChange(state, { filters });
}

function single(value: string | string[] | undefined): string | undefined {
  // A repeated parameter (`?page=1&page=9`) is a malformed request, not a list. The first value is
  // the one a URL is normally read as, and picking it beats failing on a link somebody shared.
  return Array.isArray(value) ? value[0] : value;
}

function boundedInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}
