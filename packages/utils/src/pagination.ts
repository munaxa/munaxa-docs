/**
 * Paging primitives shared by the API and the web client.
 *
 * Offset paging is the default because the UI shows totals; keyset paging exists because
 * offset paging degrades past a few thousand rows, and the document list will pass that on
 * day one of real use (`docs/architecture/19-performance-and-scalability.md`).
 */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
}

export interface CursorRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface Page<TItem> {
  readonly data: readonly TItem[];
  readonly meta: PageMeta;
}

/** Clamps untrusted paging input to the documented bounds instead of rejecting it. */
export function normalizePageRequest(input: Partial<PageRequest> | undefined): PageRequest {
  const page = Math.max(1, Math.trunc(input?.page ?? 1) || 1);
  const requested = Math.trunc(input?.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  return { page, pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, requested)) };
}

export function toPage<TItem>(
  data: readonly TItem[],
  total: number,
  request: PageRequest,
): Page<TItem> {
  return {
    data,
    meta: {
      page: request.page,
      pageSize: request.pageSize,
      total,
      hasMore: request.page * request.pageSize < total,
    },
  };
}

export function skipFor(request: PageRequest): number {
  return (request.page - 1) * request.pageSize;
}
