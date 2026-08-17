import { pageQuerySchema, sortQuerySchema } from '../common/pagination';
import { searchTermSchema } from '../common/query';

/**
 * The query an *operational* list takes, which is `adminListQuerySchema` minus one field.
 *
 * The missing field is `deleted`, and it is missing on purpose. An administration list offers a
 * three-way recycle-bin filter because an administrator has a recycle bin to manage; a picker does
 * not. Offering `deleted=all` on a read model would let a caller who may only *consume* the
 * vocabulary enumerate the parts of it that were withdrawn — which is a slightly different tenant
 * than the live one, and not a question these routes exist to answer.
 *
 * Expressed as an absent parameter rather than as a check, for the same reason
 * `notification:manage`'s `own` scope is: a request that cannot be spelled cannot be made.
 */
export function optionListQuerySchema<const TFields extends readonly [string, ...string[]]>(
  sortable: TFields,
) {
  return pageQuerySchema.merge(sortQuerySchema(sortable)).extend({
    search: searchTermSchema.optional(),
  });
}
