import { z } from 'zod';

import { pageQuerySchema, sortQuerySchema } from './pagination';

/**
 * The query shape every administration list shares.
 *
 * One definition rather than eighteen, because the alternative is eighteen chances to spell
 * `pageSize` differently, and a client that has to remember which list wants `q` and which
 * wants `search`.
 */

/**
 * A boolean that arrived as a query string.
 *
 * `z.coerce.boolean()` is wrong here and quietly so: it applies JavaScript truthiness, and
 * `Boolean('false')` is `true` — so `?includeDeleted=false` would *include* deleted rows. This
 * accepts the four spellings a client legitimately sends and rejects everything else, rather
 * than guessing at a value that decides what a caller can see.
 */
export const queryFlagSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((raw) => raw === true || raw === 'true' || raw === '1');

/** Free-text search over an endpoint's own searchable columns. Bounded, trimmed, never a pattern. */
export const searchTermSchema = z.string().trim().min(1).max(200);

/**
 * Paging, sorting, searching and the recycle-bin switch, in one schema per endpoint.
 *
 * `sortable` is passed in rather than declared here: sorting is allow-listed per endpoint,
 * because a free-text sort parameter reaching the database is an injection surface
 * (`docs/architecture/17-security-architecture.md` §6).
 *
 * `deleted` is a three-way filter rather than a flag, and the third value is the reason it
 * exists: a recycle bin wants *only* deleted rows, and expressing that as `includeDeleted=true`
 * would mean listing everything and asking the reader to filter — which is exactly the
 * fetch-then-filter the paging contract forbids, since it makes `total` a lie.
 */
export const deletedFilterSchema = z.enum(['live', 'deleted', 'all']).default('live');

export type DeletedFilter = z.infer<typeof deletedFilterSchema>;

export function adminListQuerySchema<const TFields extends readonly [string, ...string[]]>(
  sortable: TFields,
) {
  return pageQuerySchema.merge(sortQuerySchema(sortable)).extend({
    search: searchTermSchema.optional(),
    deleted: deletedFilterSchema,
  });
}

/** The fields every administered list can be sorted by, whatever it holds. */
export const COMMON_SORT_FIELDS = ['createdAt', 'updatedAt', 'name'] as const;

export type AdminListQuery = z.infer<
  ReturnType<typeof adminListQuerySchema<typeof COMMON_SORT_FIELDS>>
>;
