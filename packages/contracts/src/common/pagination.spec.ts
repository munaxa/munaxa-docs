import { describe, expect, it } from 'vitest';

import { pageQuerySchema, sortQuerySchema } from './pagination';

describe('paging contract', () => {
  it('coerces query strings and applies the documented defaults', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(pageQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it('rejects a page size beyond the maximum rather than clamping it', () => {
    expect(pageQuerySchema.safeParse({ pageSize: '10000' }).success).toBe(false);
  });

  it('allow-lists sortable fields', () => {
    const schema = sortQuerySchema(['updatedAt', 'title']);
    expect(schema.parse({ sortBy: 'title' }).sortDirection).toBe('desc');
    expect(schema.safeParse({ sortBy: 'password_hash' }).success).toBe(false);
  });
});
