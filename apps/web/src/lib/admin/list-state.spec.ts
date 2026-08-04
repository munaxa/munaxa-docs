import { describe, expect, it } from 'vitest';

import {
  type ListState,
  listQueryString,
  readListState,
  withChange,
  withFilter,
} from './list-state';

/**
 * The URL is the list's state, so these are the tests that matter most in the web app: everything a
 * screen shows is decided here, from a string a user can type or a link somebody sent them.
 */

const SORTABLE = ['createdAt', 'updatedAt', 'name', 'code'] as const;
const FILTERS = ['entityId', 'status'] as const;

function stateOf(overrides: Partial<ListState> = {}): ListState {
  return {
    page: 1,
    pageSize: 25,
    sortBy: null,
    sortDirection: 'desc',
    search: '',
    deleted: 'live',
    filters: {},
    ...overrides,
  };
}

describe('reading a list state from the URL', () => {
  it('defaults everything when the URL says nothing', () => {
    expect(readListState({}, SORTABLE)).toEqual(stateOf());
  });

  it('accepts a page, a size, a sort, a search and a recycle-bin filter', () => {
    expect(
      readListState(
        {
          page: '3',
          pageSize: '50',
          sortBy: 'name',
          sortDirection: 'asc',
          search: '  policy  ',
          deleted: 'deleted',
        },
        SORTABLE,
      ),
    ).toEqual(
      stateOf({
        page: 3,
        pageSize: 50,
        sortBy: 'name',
        sortDirection: 'asc',
        search: 'policy',
        deleted: 'deleted',
      }),
    );
  });

  it('drops a sort field the endpoint did not publish', () => {
    // The API allow-lists sortable columns because a free-text sort parameter reaching the database is
    // an injection surface. Applying the same list here means the API is never even asked.
    expect(readListState({ sortBy: 'password' }, SORTABLE).sortBy).toBeNull();
  });

  it('falls back rather than failing on an out-of-range page or size', () => {
    // A stale link is a normal thing to follow. Answering it with an error screen teaches nothing.
    expect(readListState({ page: '0' }, SORTABLE).page).toBe(1);
    expect(readListState({ page: 'nine' }, SORTABLE).page).toBe(1);
    expect(readListState({ pageSize: '10000' }, SORTABLE).pageSize).toBe(25);
  });

  it('treats an unrecognised recycle-bin value as the live list', () => {
    // The safe direction: showing fewer rows than asked for, never more.
    expect(readListState({ deleted: 'everything' }, SORTABLE).deleted).toBe('live');
  });

  it('keeps only the filters the screen declared', () => {
    expect(
      readListState({ entityId: 'e1', tenantId: 'other-tenant', status: '' }, SORTABLE, FILTERS)
        .filters,
    ).toEqual({ entityId: 'e1' });
  });

  it('reads the first value of a repeated parameter', () => {
    expect(readListState({ page: ['4', '9'] }, SORTABLE).page).toBe(4);
  });

  it('bounds a search term rather than passing on an arbitrarily long one', () => {
    expect(readListState({ search: 'a'.repeat(500) }, SORTABLE).search).toHaveLength(200);
  });
});

describe('writing a list state back to a URL', () => {
  it('omits defaults, so a canonical list has a clean address', () => {
    expect(listQueryString(stateOf())).toBe('');
  });

  it('states a sort direction only alongside a sort field', () => {
    expect(listQueryString(stateOf({ sortBy: 'name', sortDirection: 'asc' }))).toBe(
      '?sortBy=name&sortDirection=asc',
    );
  });

  it('round-trips through reading', () => {
    const original = stateOf({
      page: 2,
      pageSize: 50,
      sortBy: 'code',
      sortDirection: 'asc',
      search: 'quality manual',
      deleted: 'all',
      filters: { entityId: 'e1' },
    });
    const query = new URLSearchParams(listQueryString(original).slice(1));
    expect(readListState(Object.fromEntries(query), SORTABLE, FILTERS)).toEqual(original);
  });
});

describe('changing a list state', () => {
  it('returns to the first page when the matching rows change', () => {
    // Page four of a result set that now has two pages is an empty grid, and an empty grid reads as
    // "nothing matches" — the one thing it does not mean.
    expect(withChange(stateOf({ page: 4 }), { search: 'x' }).page).toBe(1);
    expect(withChange(stateOf({ page: 4 }), { deleted: 'deleted' }).page).toBe(1);
    expect(withChange(stateOf({ page: 4 }), { pageSize: 50 }).page).toBe(1);
  });

  it('stays put when only the sort changes', () => {
    expect(withChange(stateOf({ page: 4 }), { sortBy: 'name' }).page).toBe(4);
  });

  it('honours an explicit page even alongside a narrowing change', () => {
    expect(withChange(stateOf({ page: 4 }), { search: 'x', page: 2 }).page).toBe(2);
  });

  it('clears a filter set to nothing rather than filtering on an empty string', () => {
    const filtered = withFilter(stateOf(), 'entityId', 'e1');
    expect(withFilter(filtered, 'entityId', '').filters).toEqual({});
  });
});
