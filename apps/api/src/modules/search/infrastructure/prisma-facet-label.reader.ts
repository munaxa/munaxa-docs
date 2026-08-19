import { Injectable } from '@nestjs/common';

import { requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { FacetLabelReader, LabelledFacet } from '../application/ports';

/**
 * Names for facet identifiers, and nothing else — Slice 11.
 *
 * ## What makes this safe
 *
 * Every identifier it is asked about came out of a facet the engine counted **inside** the ACL
 * predicate: `PostgresSearchAdapter.countFacet` runs the same `WHERE` the hits and the total run,
 * tenant first, then `acl_subjects && callerSubjects AND NOT (acl_deny_subjects && …)`. So a value
 * reaching this reader is one the caller has already been shown a count for, and asking for its
 * name discloses nothing the response did not already carry.
 *
 * That is the whole security argument, and it depends on this reader never widening the set. It
 * cannot: there is no list, no filter and no paging here. `IN (…)` over identifiers the caller
 * supplied, `SELECT id, name`, and a tenant predicate in every one of the four queries.
 *
 * ## Why `tenantId` is written out
 *
 * Row-level security is already on these tables, and it would very likely be enough. "Very likely"
 * is not the standard for a query that turns an identifier into a name: an identifier from another
 * tenant must resolve to nothing because the *query* says so, not because a policy elsewhere
 * happens to be in force. It is one clause, and it makes the boundary readable at the call site.
 *
 * ## Why deleted rows resolve to nothing
 *
 * A soft-deleted type still has documents filed under it, so its identifier can legitimately appear
 * in a facet — and this returns no name for it. The alternative was to resolve deleted rows too,
 * which reads better and says more: a withdrawn part of the vocabulary would keep announcing itself
 * to everyone who can search. The caller sees the value it already had, which is the honest answer
 * to "what is this called" when the answer has been withdrawn.
 *
 * ## One query per facet
 *
 * Four at the very most, and only for facets that produced buckets. A facet is capped at twenty
 * buckets by the engine, so each of these is an `IN` over at most twenty identifiers. There is no
 * path here that issues a query per value.
 */
@Injectable()
export class PrismaFacetLabelReader implements FacetLabelReader {
  async labelsFor(
    request: Readonly<Partial<Record<LabelledFacet, readonly string[]>>>,
  ): Promise<Readonly<Partial<Record<LabelledFacet, Readonly<Record<string, string>>>>>> {
    const tenantId = requireContext().tenantId;
    const tx = requireTransaction();

    /** The same shape for all four: live rows of this tenant, by identifier, id and name only. */
    const where = (ids: readonly string[]) => ({
      tenantId,
      id: { in: [...ids] },
      deletedAt: null,
    });
    const select = { id: true, name: true } as const;

    const wanted = (facet: LabelledFacet): readonly string[] => {
      // De-duplicated, because a bucket list is already distinct but a caller of this port need not
      // be, and an `IN` is the wrong place to discover that.
      return [...new Set(request[facet] ?? [])];
    };

    const [type, category, department, entity] = await Promise.all([
      wanted('type').length === 0
        ? []
        : tx.documentType.findMany({ where: where(wanted('type')), select }),
      wanted('category').length === 0
        ? []
        : tx.category.findMany({ where: where(wanted('category')), select }),
      wanted('department').length === 0
        ? []
        : tx.department.findMany({ where: where(wanted('department')), select }),
      wanted('entity').length === 0
        ? []
        : tx.entity.findMany({ where: where(wanted('entity')), select }),
    ]);

    const labels: Partial<Record<LabelledFacet, Readonly<Record<string, string>>>> = {};
    for (const [facet, rows] of [
      ['type', type],
      ['category', category],
      ['department', department],
      ['entity', entity],
    ] as const) {
      if (rows.length > 0) {
        labels[facet] = Object.fromEntries(rows.map((row) => [row.id, row.name]));
      }
    }
    return labels;
  }
}
