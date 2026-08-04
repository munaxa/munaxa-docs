import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { type UserId, UserStatus, asId } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { DirectoryScope, UserContact, UserDirectory } from '../application/ports';

/**
 * Recipient lookup, and the routing lookups the workflow engine resolves participants with.
 *
 * Deleted and never-activated users are excluded everywhere in this file. An invitation that was
 * withdrawn is not an address the product should still be writing to, a deleted user's mailbox may
 * belong to somebody else by now — and, for the routing lookups Phase 4 added, a resolver that
 * yielded a disabled account would route an approval to somebody who cannot sign in. The stage
 * would then sit there until it escalated, which looks exactly like somebody ignoring their work.
 */
@Injectable()
export class PrismaUserDirectory implements UserDirectory {
  async contactFor(userId: UserId): Promise<UserContact | null> {
    const [contact] = await this.contactsFor([userId]);
    return contact ?? null;
  }

  async contactsFor(userIds: readonly UserId[]): Promise<readonly UserContact[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await requireTransaction().user.findMany({
      where: { ...this.live(), id: { in: [...userIds] } },
      select: { id: true, email: true, displayName: true },
    });
    return rows.map((row) => ({
      userId: asId<UserId>(row.id),
      email: row.email,
      displayName: row.displayName,
    }));
  }

  /**
   * Everybody holding a role, within a scope.
   *
   * The role is matched by *key* rather than by identifier, because a workflow definition names one
   * — `07-workflow-architecture.md` §8 forbids the engine naming a role in code, and an identifier
   * in a definition would be exactly as brittle as a name in code the day a tenant is re-seeded.
   *
   * The scope narrows by where the holder sits. `DEPARTMENT` matches the department **and its
   * descendants** by materialised path, because a role granted to somebody in a sub-team is a role
   * held within the parent department too — the same reading the ACL resolver gives the tree
   * ([ADR-0014](../../../../../docs/architecture/adr/0014-materialised-path-as-text.md)).
   */
  async holdersOfRole(roleKey: string, scope: DirectoryScope): Promise<readonly UserId[]> {
    const membership = await this.scopeFilter(scope);
    if (membership === NOBODY) {
      return [];
    }
    const rows = await requireTransaction().user.findMany({
      where: {
        ...this.live(),
        roles: { some: { role: { key: roleKey, deletedAt: null } } },
        ...membership,
      },
      select: { id: true },
      orderBy: { displayName: 'asc' },
    });
    return rows.map((row) => asId<UserId>(row.id));
  }

  async membersOfDepartment(
    departmentId: string,
    managersOnly: boolean,
  ): Promise<readonly UserId[]> {
    const rows = await requireTransaction().user.findMany({
      where: {
        ...this.live(),
        departments: {
          some: {
            departmentId,
            ...(managersOnly ? { isManager: true } : {}),
          },
        },
      },
      select: { id: true },
      orderBy: { displayName: 'asc' },
    });
    return rows.map((row) => asId<UserId>(row.id));
  }

  /**
   * Whoever manages this person.
   *
   * Their primary department's managers, or — for somebody with no primary department — the
   * managers of every department they belong to. The person themselves is removed from the result:
   * "escalate to my manager" resolving to me is an escalation that goes nowhere, and worse, it
   * hides the fact that there is nobody above me to escalate to.
   */
  async managersOf(userId: UserId): Promise<readonly UserId[]> {
    const tx = requireTransaction();
    const memberships = await tx.userDepartment.findMany({
      where: { userId, tenantId: this.tenantId() },
      select: { departmentId: true, isPrimary: true },
    });
    if (memberships.length === 0) {
      return [];
    }
    const primary = memberships.filter((membership) => membership.isPrimary);
    const looked = (primary.length > 0 ? primary : memberships).map(
      (membership) => membership.departmentId,
    );

    const rows = await tx.user.findMany({
      where: {
        ...this.live(),
        id: { not: userId },
        departments: { some: { departmentId: { in: looked }, isManager: true } },
      },
      select: { id: true },
      orderBy: { displayName: 'asc' },
    });
    return rows.map((row) => asId<UserId>(row.id));
  }

  async activeAmong(userIds: readonly UserId[]): Promise<readonly UserId[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await requireTransaction().user.findMany({
      where: { ...this.live(), id: { in: [...userIds] } },
      select: { id: true },
    });
    const found = new Set(rows.map((row) => row.id));
    // Filtered against the *input* order rather than returned in query order: an `ordered` stage
    // takes its sequence from the order resolvers named people in, and re-ordering here would
    // rearrange somebody's approval chain alphabetically.
    return userIds.filter((userId) => found.has(userId));
  }

  /**
   * The scope, as a filter on the user.
   *
   * Returns `NOBODY` for a scope naming a node the document does not have. That is the narrowing
   * default, and it is the safe one: widening a `DOCUMENT_DEPARTMENT` scope to the tenant when a
   * document belongs to no department would route the approval to every holder of the role.
   */
  private async scopeFilter(scope: DirectoryScope): Promise<Prisma.UserWhereInput | typeof NOBODY> {
    if (scope.kind === 'TENANT') {
      return {};
    }
    if (scope.nodeId === null) {
      return NOBODY;
    }
    if (scope.kind === 'ENTITY') {
      return { departments: { some: { department: { entityId: scope.nodeId } } } };
    }

    const department = await requireTransaction().department.findFirst({
      where: { id: scope.nodeId, tenantId: this.tenantId(), deletedAt: null },
      select: { path: true },
    });
    if (department === null) {
      return NOBODY;
    }
    return {
      departments: {
        some: {
          department: {
            // The node itself, or anything beneath it. A prefix match on the materialised path is
            // an index range scan whatever the depth, which is what ADR-0014 is for.
            OR: [{ id: scope.nodeId }, { path: { startsWith: `${department.path}.` } }],
          },
        },
      },
    };
  }

  private live(): Prisma.UserWhereInput {
    return { tenantId: this.tenantId(), deletedAt: null, status: UserStatus.ACTIVE };
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

/** A filter that matches nobody, distinguished from "no filter" — which matches everybody. */
const NOBODY = Symbol('NoUsers');
