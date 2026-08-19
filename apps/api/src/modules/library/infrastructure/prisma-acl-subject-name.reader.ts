import { Injectable } from '@nestjs/common';

import { AclSubjectType, type AclSubjectTypeKey } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { AclSubjectNameReader } from '../application/ports';

/**
 * Names for ACL subjects, and nothing else — Slice 12.
 *
 * ## What makes this safe
 *
 * Every identifier it is asked about was read off an entry written on the node the caller is
 * already looking at, behind `document:permission:manage` and a reach check on that node. So a
 * subject reaching this reader is one whose entry the caller is being shown, and asking what it is
 * called discloses nothing the response did not already carry.
 *
 * That is the whole argument, and it holds only while this cannot widen the set. It cannot: there
 * is no list, no filter and no paging here. `IN (…)` over identifiers the caller supplied, two
 * columns, and a tenant predicate in each of the three queries.
 *
 * ## Why `tenantId` is written out
 *
 * Row-level security is on all three tables and would very likely be enough. "Very likely" is not
 * the standard for a query that turns an identifier into somebody's name: an identifier from
 * another tenant must resolve to nothing because the *query* says so, not because a policy
 * elsewhere happens to be in force. It is one clause, and it puts the boundary at the call site
 * where a reader can see it.
 *
 * ## Why deleted subjects resolve to nothing
 *
 * An entry outlives its subject — `PermissionService.validate` checks the permission and the
 * subject *type* and never that the identifier names anything, so an entry for a deleted user is a
 * state the product can genuinely be in. Resolving deleted rows would keep a departed employee's
 * name on a permissions screen after the account was removed. The caller sees the identifier, which
 * is the honest answer to "who is this" once the answer has been withdrawn — and a stale entry
 * showing a raw identifier is exactly the thing an administrator should notice and revoke.
 *
 * ## One query per subject type
 *
 * Three at the very most, and only for the types actually present on the node. A node's entries are
 * capped at 500 by `replaceAclSchema`, so each of these is an `IN` over at most that many distinct
 * identifiers. There is no path here that issues a query per entry.
 */
@Injectable()
export class PrismaAclSubjectNameReader implements AclSubjectNameReader {
  async namesFor(
    request: Readonly<Partial<Record<AclSubjectTypeKey, readonly string[]>>>,
  ): Promise<Readonly<Partial<Record<AclSubjectTypeKey, Readonly<Record<string, string>>>>>> {
    const tenantId = requireContext().tenantId;
    const tx = requireTransaction();

    /** The same shape for all three: live rows of this tenant, by identifier, two columns. */
    const where = (ids: readonly string[]) => ({ tenantId, id: { in: [...ids] }, deletedAt: null });

    const wanted = (subject: AclSubjectTypeKey): readonly string[] => {
      // De-duplicated: one subject commonly holds several permissions on a node, so the raw entry
      // list repeats identifiers, and an `IN` is the wrong place to discover that.
      return [...new Set(request[subject] ?? [])];
    };

    const [users, roles, departments] = await Promise.all([
      wanted(AclSubjectType.USER).length === 0
        ? []
        : tx.user.findMany({
            where: where(wanted(AclSubjectType.USER)),
            select: { id: true, displayName: true },
          }),
      wanted(AclSubjectType.ROLE).length === 0
        ? []
        : tx.role.findMany({
            where: where(wanted(AclSubjectType.ROLE)),
            select: { id: true, name: true },
          }),
      wanted(AclSubjectType.DEPARTMENT).length === 0
        ? []
        : tx.department.findMany({
            where: where(wanted(AclSubjectType.DEPARTMENT)),
            select: { id: true, name: true },
          }),
    ]);

    const names: Partial<Record<AclSubjectTypeKey, Readonly<Record<string, string>>>> = {};
    for (const [subject, rows] of [
      [AclSubjectType.USER, users.map((row) => [row.id, row.displayName] as const)],
      [AclSubjectType.ROLE, roles.map((row) => [row.id, row.name] as const)],
      [AclSubjectType.DEPARTMENT, departments.map((row) => [row.id, row.name] as const)],
    ] as const) {
      if (rows.length > 0) {
        names[subject] = Object.fromEntries(rows);
      }
    }
    return names;
  }
}
