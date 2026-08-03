import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@edms/utils';

/**
 * Paging, filtering and sorting as they arrive on the wire.
 *
 * Query values are strings, so every schema here coerces and bounds rather than trusting.
 * A page size beyond the maximum is rejected, not silently clamped: a client asking for
 * 10 000 rows has a bug worth surfacing.
 */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const sortDirectionSchema = z.enum(['asc', 'desc']);

/**
 * Sorting is allow-listed per endpoint by passing the sortable fields in. A free-text sort
 * parameter reaching the database is an injection surface
 * (`docs/architecture/17-security-architecture.md` §6).
 */
export function sortQuerySchema<const TFields extends readonly [string, ...string[]]>(
  fields: TFields,
) {
  return z.object({
    sortBy: z.enum(fields).optional(),
    sortDirection: sortDirectionSchema.default('desc'),
  });
}

export const pageMetaSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  hasMore: z.boolean(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;
export type CursorQuery = z.infer<typeof cursorQuerySchema>;
export type SortDirection = z.infer<typeof sortDirectionSchema>;
export type PageMetaContract = z.infer<typeof pageMetaSchema>;
