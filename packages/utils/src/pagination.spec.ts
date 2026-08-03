import { describe, expect, it } from 'vitest';

import { MAX_PAGE_SIZE, normalizePageRequest, skipFor, toPage } from './pagination';

describe('pagination', () => {
  it('clamps hostile input rather than rejecting it', () => {
    expect(normalizePageRequest({ page: -3, pageSize: 5_000 })).toEqual({
      page: 1,
      pageSize: MAX_PAGE_SIZE,
    });
    expect(normalizePageRequest(undefined)).toEqual({ page: 1, pageSize: 25 });
  });

  it('reports hasMore from the total, not from the page length', () => {
    const page = toPage(['a', 'b'], 10, { page: 1, pageSize: 2 });
    expect(page.meta.hasMore).toBe(true);
    expect(toPage(['a'], 5, { page: 3, pageSize: 2 }).meta.hasMore).toBe(false);
  });

  it('computes the offset from the one-based page', () => {
    expect(skipFor({ page: 3, pageSize: 25 })).toBe(50);
  });
});
