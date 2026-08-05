/**
 * The keyset cursor (`12-search-architecture.md` §5): pagination on `(sort value, document
 * id)`, never an offset — an offset re-counts everything it skips, which degrades exactly when
 * a search matters most, and shifts under concurrent writes so page two repeats page one.
 *
 * The cursor is opaque to clients and versioned by its sort key: a cursor minted under one
 * ordering refuses to continue another, because "page two of a different sort" is not a page
 * of anything. Decoding reports rather than throws — the domain has no HTTP vocabulary; the
 * service turns a refusal into the validation error the API speaks.
 */
export const SearchSort = {
  RELEVANCE: 'RELEVANCE',
  RECENT: 'RECENT',
  NUMBER: 'NUMBER',
  TITLE: 'TITLE',
} as const;

export type SearchSortKey = (typeof SearchSort)[keyof typeof SearchSort];

export function isSearchSortKey(value: string): value is SearchSortKey {
  return Object.values(SearchSort).includes(value as SearchSortKey);
}

export interface SearchCursor {
  readonly sort: SearchSortKey;
  /** The last row's sort value: a rank, an ISO instant, a number or a title. */
  readonly value: string | number | null;
  readonly documentId: string;
}

export type DecodedCursor =
  | { readonly ok: true; readonly cursor: SearchCursor }
  | { readonly ok: false; readonly reason: 'UNREADABLE' | 'SORT_MISMATCH' };

export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSearchCursor(encoded: string, expectedSort: SearchSortKey): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'UNREADABLE' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'UNREADABLE' };
  }
  const candidate = parsed as Partial<SearchCursor>;
  if (
    typeof candidate.documentId !== 'string' ||
    candidate.documentId === '' ||
    typeof candidate.sort !== 'string' ||
    !isSearchSortKey(candidate.sort) ||
    !(
      candidate.value === null ||
      typeof candidate.value === 'string' ||
      typeof candidate.value === 'number'
    )
  ) {
    return { ok: false, reason: 'UNREADABLE' };
  }
  if (candidate.sort !== expectedSort) {
    return { ok: false, reason: 'SORT_MISMATCH' };
  }
  return {
    ok: true,
    cursor: { sort: candidate.sort, value: candidate.value, documentId: candidate.documentId },
  };
}
