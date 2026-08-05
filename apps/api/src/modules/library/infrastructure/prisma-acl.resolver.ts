import { Inject, Injectable } from '@nestjs/common';

import type { Capabilities } from '@edms/contracts';
import { type AnyId, type PermissionKey, ScopeType, type ScopeRef, asId } from '@edms/domain';

import type {
  AclResolver,
  AuthorizationSubject,
  Decision,
  IndexAclSubjects,
  VisibilityFilter,
} from '../../../core/authorization/acl-resolver.port';
import { UNIT_OF_WORK, type UnitOfWork, requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { aclFingerprint, callerSubjectTokens, indexAclSubjects } from '../domain/acl-subjects';

/**
 * The first real `ACL_RESOLVER` — resolution over what genuinely exists.
 *
 * The algorithm is `08-permission-model.md` §3, run against a database that holds no ACL entry
 * yet: steps 3–5 find nothing to match, so every decision falls through to step 6, the
 * tenant-level role grant, and step 7, closed by default. That is deliberately *not* a
 * simplification of the model — it is the model, evaluated over the grants that exist. The
 * walk, the entries it collects and deny precedence arrive with the phase that builds ACL
 * entries; they extend this class and its domain functions, and nothing that calls the port
 * changes.
 *
 * Search is what forces this binding now. The index must materialise `acl_subjects` "computed
 * by the same pure resolver the API uses" (`12-search-architecture.md` §3), which requires the
 * resolver to exist — a search module computing its own answer would be the divergent second
 * implementation the port's contract forbids. `DenyAllAclResolver` could not serve the index:
 * an index nobody can see is not a search feature, and a direct read today is *not* denied —
 * it is gated by the tenant-level role grant, which is exactly what this class resolves.
 *
 * The grant tables it reads — `role_permission`, `user_department` — belong to Identity and
 * Organization. Reading them here rather than through those modules' services is the port's
 * own design: `08` names the resolver "the only place a decision is made", and a decision
 * assembled from three application services would put the algorithm's pieces in three modules.
 * Editing those tables stays where it belongs; deciding with them happens here.
 *
 * The per-`(user, scope, permission)` cache of `08` §8 is deliberately absent: it is named
 * there as an optimisation only, and caching a two-table lookup before anything measures it
 * would be speculative machinery. It arrives with the walk, whose cost will warrant it.
 */
@Injectable()
export class PrismaAclResolver implements AclResolver {
  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async resolve(
    subject: AuthorizationSubject,
    _scope: ScopeRef,
    permission: PermissionKey,
  ): Promise<Decision> {
    // Closed by default, before any query: no roles, no grant, no reach. This is also what
    // keeps the composition test honest without a database — an empty subject resolves to a
    // refusal with nothing to look up.
    if (subject.roleIds.length === 0) {
      return { allowed: false, decidedAt: null, reason: 'CLOSED_BY_DEFAULT' };
    }
    return this.unitOfWork.run(async () => {
      const granted = await this.grantedAmong(subject.roleIds, [permission]);
      if (granted.length > 0) {
        return {
          allowed: true,
          // The node that decided it: the tenant, because a role grant is tenant-wide reach.
          decidedAt: { type: ScopeType.TENANT, id: asId<AnyId>(requireContext().tenantId) },
          reason: 'ROLE_GRANT',
        } satisfies Decision;
      }
      return {
        allowed: false,
        decidedAt: null,
        reason: 'CLOSED_BY_DEFAULT',
      } satisfies Decision;
    });
  }

  async capabilitiesFor(
    subject: AuthorizationSubject,
    _scope: ScopeRef,
    permissions: readonly PermissionKey[],
  ): Promise<Capabilities> {
    const granted =
      subject.roleIds.length === 0
        ? []
        : await this.unitOfWork.run(() => this.grantedAmong(subject.roleIds, permissions));
    const held = new Set(granted);
    const capabilities: Capabilities = {};
    for (const permission of permissions) {
      capabilities[permission] = held.has(permission);
    }
    return capabilities;
  }

  async visibilityFilter(
    subject: AuthorizationSubject,
    permission: PermissionKey,
  ): Promise<VisibilityFilter> {
    return this.unitOfWork.run(async () => {
      const [departmentIds, granted] = await Promise.all([
        this.departmentsOf(subject),
        this.grantedAmong(subject.roleIds, [permission]),
      ]);
      const tokens = callerSubjectTokens({
        userId: subject.userId,
        roleIds: subject.roleIds,
        departmentIds,
        grantedPermissions: granted,
      });
      return {
        subjectIds: tokens.map((token) => asId<AnyId>(token)),
        deniedScopeIds: [],
        unrestricted: false,
        fingerprint: aclFingerprint(tokens, []),
      } satisfies VisibilityFilter;
    });
  }

  aclSubjectsFor(_scope: ScopeRef, permission: PermissionKey): Promise<IndexAclSubjects> {
    // Pure in this generation: with no entries on any chain, every scope materialises the
    // grant token and nothing else. The signature takes the scope because the walk will need
    // it, and changing a port's shape later is how skeleton drift starts (the Phase 7 lesson).
    const { allowSubjects, denySubjects } = indexAclSubjects(permission);
    return Promise.resolve({
      allowSubjects,
      denySubjects,
      fingerprint: aclFingerprint(allowSubjects, denySubjects),
    });
  }

  /** Which of these permissions any of the caller's roles holds at tenant level. */
  private async grantedAmong(
    roleIds: readonly AnyId[],
    permissions: readonly PermissionKey[],
  ): Promise<readonly PermissionKey[]> {
    if (roleIds.length === 0 || permissions.length === 0) {
      return [];
    }
    const rows = await requireTransaction().rolePermission.findMany({
      where: {
        tenantId: requireContext().tenantId,
        roleId: { in: [...roleIds] },
        permission: { in: [...permissions] },
      },
      select: { permission: true },
      distinct: ['permission'],
    });
    return rows.map((row) => row.permission as PermissionKey);
  }

  /**
   * The caller's departments, resolved here rather than trusted from the subject: they are
   * not in the token (`AclGuard` builds the subject with an empty list), and §3 step 1 makes
   * collecting them the resolver's own job.
   */
  private async departmentsOf(subject: AuthorizationSubject): Promise<readonly AnyId[]> {
    if (subject.departmentIds.length > 0) {
      return subject.departmentIds;
    }
    if (subject.userId === '') {
      return [];
    }
    const rows = await requireTransaction().userDepartment.findMany({
      where: { tenantId: requireContext().tenantId, userId: subject.userId },
      select: { departmentId: true },
    });
    return rows.map((row) => asId<AnyId>(row.departmentId));
  }
}
