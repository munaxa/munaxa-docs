import type { DeletedFilter, SortDirection } from '@edms/contracts';
import { type PageRequest, skipFor } from '@edms/utils';

/**
 * Turning an administration list query into the pieces of a Prisma query.
 *
 * Deliberately **pieces**, not a finished `where`. A helper that returned a whole query object
 * would have to be typed loosely enough to fit eighteen different models, and the moment a
 * repository spreads `Record<string, unknown>` into `where`, the tenant filter and the
 * soft-delete filter stop being type-checked — which are the two clauses whose absence is a data
 * leak rather than a bug. So each repository still writes its own `where` literal, and these fill
 * in the parts that are identical everywhere.
 */

/**
 * What to put in `deletedAt` for a three-way recycle-bin filter.
 *
 * `undefined` — not "no filter" by accident but by design — is how Prisma spells "don't
 * constrain this column", so the `all` case needs no branch at the call site.
 */
export function deletedCondition(filter: DeletedFilter): null | { not: null } | undefined {
  switch (filter) {
    case 'live':
      return null;
    case 'deleted':
      return { not: null };
    case 'all':
      return undefined;
  }
}

/**
 * Escapes the LIKE metacharacters in a search term.
 *
 * **Prisma's `contains` does not do this.** It parameterises the value — so there is no SQL
 * injection — and then interpolates that parameter into a `LIKE '%' || $1 || '%'` pattern, where
 * `%` and `_` keep their pattern meaning. So `?search=%` matches every row, and `?search=50%`
 * matches rows containing "50" followed by anything, which is not what the person typing it means.
 *
 * A search box that quietly matches everything is a wrong answer rather than a breach — these lists
 * are tenant-scoped and permission-gated — but "wrong answer, silently" is the worse kind of defect
 * to ship in a filter.
 *
 * Backslash is escaped first, and must be: doing it last would double the backslashes this function
 * itself introduced. PostgreSQL's default LIKE escape character is the backslash, which is what
 * makes a prefixed one mean "the literal next character".
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * The `OR` branches for a free-text search across a resource's own text columns.
 *
 * Generic over the field names so the result is a union of single-key object types — which is what
 * makes it assignable to Prisma's `WhereInput`, and what makes a typo in a field name a compile
 * error rather than a filter that silently matches nothing.
 *
 * Returns `undefined` for an absent term and for an empty field list, so the call site needs no
 * branch. Empty matters: an empty `OR` array matches *no rows* in Prisma, so returning one would
 * turn a search on a resource with no text columns into an empty list rather than an unfiltered one.
 */
export function searchConditions<const TField extends string>(
  term: string | undefined,
  fields: readonly TField[],
): { [K in TField]?: { contains: string; mode: 'insensitive' } }[] | undefined {
  if (term === undefined || term.length === 0 || fields.length === 0) {
    return undefined;
  }
  const literal = escapeLikeTerm(term);
  return fields.map(
    (field) =>
      ({ [field]: { contains: literal, mode: 'insensitive' } }) as {
        [K in TField]?: { contains: string; mode: 'insensitive' };
      },
  );
}

/**
 * The `orderBy` for an allow-listed sort.
 *
 * The allow-list is the contract's `z.enum`, so an unknown field cannot arrive here — which is
 * the point of allow-listing per endpoint rather than accepting a sort column name: a free-text
 * sort parameter reaching the database is an injection surface
 * (`17-security-architecture.md` §6).
 *
 * A second, stable key is always appended. Without one, two rows with equal sort values can come
 * back in either order on either page, so a row is silently shown twice or not at all as the user
 * pages — the classic non-deterministic pagination defect. `id` is a UUID v7, so it is also
 * creation order, which makes the tiebreak meaningful rather than arbitrary.
 */
export function orderByFor<const TField extends string>(
  sortBy: TField | undefined,
  direction: SortDirection,
  fallback: TField,
): ({ [K in TField]?: SortDirection } | { id: SortDirection })[] {
  const field = sortBy ?? fallback;
  return [{ [field]: direction } as { [K in TField]?: SortDirection }, { id: direction }];
}

/** `skip` and `take`, from a validated page request. */
export function pageArgs(request: PageRequest): { readonly skip: number; readonly take: number } {
  return { skip: skipFor(request), take: request.pageSize };
}
