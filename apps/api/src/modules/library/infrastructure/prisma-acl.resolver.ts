import { Inject, Injectable } from '@nestjs/common';

import type { Capabilities } from '@edms/contracts';
import {
  type AnyId,
  type PermissionKey,
  ScopeType,
  type ScopeRef,
  asId,
  idsInPath,
  survivesBrokenInheritance,
} from '@edms/domain';

import type {
  AclResolver,
  AuthorizationSubject,
  Decision,
  IndexAclSubjects,
  VisibilityFilter,
  VisibilityRegion,
} from '../../../core/authorization/acl-resolver.port';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { UNIT_OF_WORK, type UnitOfWork, requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';
import { aclFingerprint, callerSubjectTokens } from '../domain/acl-subjects';
import {
  type ChainEntry,
  type ChainNode,
  callerSubjectIds,
  decideFromEntries,
  effectiveChain,
  indexSubjectsFromEntries,
} from '../domain/acl-walk';
import {
  ACL_REPOSITORY,
  SCOPE_CHAIN_READER,
  type AclEntryRecord,
  type AclRepository,
  type ChainNodeRecord,
  type ScopeChainReader,
} from '../application/ports';

/**
 * `ACL_RESOLVER` — the only place an authorisation decision is made, now with the walk behind it.
 *
 * Phase 8 bound this class over a database that held no ACL entry: steps 3–5 of `08 §3` found
 * nothing, every decision fell through to step 6's tenant-level role grant, and step 7 kept it
 * closed by default. That was the model evaluated over the grants that existed, not a simplification
 * of it — which is why **Phase 14 extends this class and changes nothing that calls it**. The four
 * methods have the signatures they had; `AclGuard`, the dashboard, search's query side and search's
 * projection all call exactly what they called before and get answers that now depend on the object.
 *
 * ## What each method now does
 *
 * `resolve` reads the chain, truncates it at the deepest inheritance break the permission does not
 * survive, reads the entries on it for the caller's subjects, and applies deny-wins. `capabilitiesFor`
 * is the same walk asked once and answered for many permissions, which is why it is a method rather
 * than a loop over `resolve` — twenty permissions on one document is one chain read, not twenty.
 * `visibilityFilter` inverts the question: instead of "does this caller reach this node", it asks
 * "where does this caller reach", and returns both the token set the search index compares against
 * and the regions a relational list turns into a `WHERE`. `aclSubjectsFor` is the walk expressed as
 * two token arrays, which is what an index entry stores.
 *
 * ## The cache, and why it arrives now
 *
 * The comment this replaced said the `(user, scope, permission)` cache of `08 §8` was "deliberately
 * absent: caching a two-table lookup before anything measures it would be speculative machinery. It
 * arrives with the walk, whose cost will warrant it." It does. A decision is now up to five reads of
 * the tree plus one of the entries, and `AclGuard` runs on every object route.
 *
 * Two things are cached, with different keys and for different reasons.
 *
 * - **The chain**, per `(tenant, scope)`. It is the expensive half and the half that changes least:
 *   a folder's ancestry changes when somebody moves it, which is a `library.folder-moved` event.
 * - **The decision**, per `(tenant, user, scope, permission)` — §8's key exactly.
 *
 * **Invalidation is by prefix, in the transaction that caused it**, never by TTL alone. Every write
 * that could change an answer — an ACL edit, an inheritance change, a role's permissions, a user's
 * roles, a department membership, a document move — clears `acl:<tenant>:` and is followed by the
 * `library.acl-changed` event that re-projects the search index. The TTL is a backstop for the case
 * prefix invalidation cannot see: another process's write to shared ancestry. Setting
 * `ACL_CACHE_TTL_SECONDS=0` disables the cache, and a cold cache produces the same answer — which is
 * §8's own requirement and is asserted rather than asserted-to.
 *
 * ## What it still does not do
 *
 * Step 8 — state and confidentiality — is deliberately **not** applied here. See the phase report:
 * those modifiers are enforced where the act happens, because "may not print this" and "may not
 * reach this document" are different refusals with different error codes, and collapsing them into
 * a `404` would tell somebody holding `document:print` that a document they can see does not exist.
 */
@Injectable()
export class PrismaAclResolver implements AclResolver {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ACL_REPOSITORY) private readonly entries: AclRepository,
    @Inject(SCOPE_CHAIN_READER) private readonly chains: ScopeChainReader,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async resolve(
    subject: AuthorizationSubject,
    scope: ScopeRef,
    permission: PermissionKey,
  ): Promise<Decision> {
    // Closed by default, before any query: no roles, no grant, no reach. It is also what keeps the
    // composition test honest without a database — an empty subject resolves to a refusal with
    // nothing to look up.
    if (subject.roleIds.length === 0 && subject.userId === '') {
      return { allowed: false, decidedAt: null, reason: 'CLOSED_BY_DEFAULT' };
    }

    const cacheKey = this.decisionKey(subject, scope, permission);
    const cached = await this.readCache<Decision>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const decision = await this.unitOfWork.run(async () => {
      const resolved = await this.resolveMany(subject, scope, [permission]);
      return resolved.decisions[permission] ?? closed();
    });
    await this.writeCache(cacheKey, decision);
    return decision;
  }

  async capabilitiesFor(
    subject: AuthorizationSubject,
    scope: ScopeRef,
    permissions: readonly PermissionKey[],
  ): Promise<Capabilities> {
    if (permissions.length === 0) {
      return {};
    }
    if (subject.roleIds.length === 0 && subject.userId === '') {
      return Object.fromEntries(permissions.map((permission) => [permission, false]));
    }
    const resolved = await this.unitOfWork.run(() => this.resolveMany(subject, scope, permissions));
    const capabilities: Capabilities = {};
    for (const permission of permissions) {
      capabilities[permission] = resolved.decisions[permission]?.allowed ?? false;
    }
    return capabilities;
  }

  async visibilityFilter(
    subject: AuthorizationSubject,
    permission: PermissionKey,
  ): Promise<VisibilityFilter> {
    // Cached beside the decisions, under the same tenant prefix, so one ACL edit clears both. It
    // matters more than the decision cache does: a dashboard page asks for it once per widget and a
    // list asks for it once per count, so an uncached filter is the same six reads repeated across
    // one request rather than across one session.
    const cacheKey = this.filterKey(subject, permission);
    const cached = await this.readCache<VisibilityFilter>(cacheKey);
    if (cached !== null) {
      return cached;
    }
    const filter = await this.computeVisibilityFilter(subject, permission);
    await this.writeCache(cacheKey, filter);
    return filter;
  }

  private async computeVisibilityFilter(
    subject: AuthorizationSubject,
    permission: PermissionKey,
  ): Promise<VisibilityFilter> {
    return this.unitOfWork.run(async () => {
      const roleIds = await this.roleIdsOf(subject);
      const departmentIds = await this.departmentsOf(subject);
      const subjectIds = callerSubjectIds({
        userId: String(subject.userId),
        roleIds: roleIds.map(String),
        departmentIds: departmentIds.map(String),
      });
      const limit = this.config.acl.maxSubjectEntries;
      const [granted, entries, breaks] = await Promise.all([
        this.grantedAmong(roleIds, [permission]),
        this.entries.listForSubjects(subjectIds, permission, limit + 1),
        this.chains.brokenInheritancePaths(),
      ]);

      // Past the bound, the filter degrades **closed**: the tenant-wide allow is dropped and every
      // deny that was read is kept. A configuration nobody can render is not a reason to widen the
      // answer, and the ordering in the repository put the denies first for exactly this case.
      const truncated = entries.length > limit;
      const readable = truncated ? entries.slice(0, limit) : entries;

      const tokens = callerSubjectTokens({
        userId: subject.userId,
        roleIds,
        departmentIds,
        grantedPermissions: granted,
      });

      const allowSources = readable.filter((entry) => entry.effect === 'ALLOW');
      const denySources = readable.filter((entry) => entry.effect === 'DENY');
      const inheritanceProof = survivesBrokenInheritance(permission);
      const cuts = inheritanceProof ? [] : breaks;

      const allowedRegions = await this.regionsFor(allowSources, cuts, {
        tenantWide: granted.length > 0 && !truncated,
      });
      const deniedRegions = await this.regionsFor(denySources, cuts, { tenantWide: false });

      return {
        subjectIds: tokens.map((token) => asId<AnyId>(token)),
        deniedScopeIds: denySources.map((entry) => entry.scope.id),
        unrestricted: false,
        fingerprint: aclFingerprint(
          tokens,
          denySources.map((entry) => `${entry.scope.type}:${String(entry.scope.id)}`),
        ),
        allowedRegions,
        deniedRegions,
      } satisfies VisibilityFilter;
    });
  }

  async aclSubjectsFor(scope: ScopeRef, permission: PermissionKey): Promise<IndexAclSubjects> {
    return this.unitOfWork.run(async () => {
      const chain = await this.chainFor(scope);
      if (chain === null) {
        // The object is gone. An entry for it is about to be removed by the same projection run;
        // materialising "allow nobody" in the meantime is the closed answer.
        return { allowSubjects: [], denySubjects: [], fingerprint: aclFingerprint([], []) };
      }
      const effective = effectiveChain(chain, permission);
      const entries = await this.entriesOnChain(effective, permission, null);
      const { allowSubjects, denySubjects } = indexSubjectsFromEntries(
        effective,
        entries,
        permission,
      );
      return {
        allowSubjects,
        denySubjects,
        fingerprint: aclFingerprint(allowSubjects, denySubjects),
      };
    });
  }

  // --- The walk ----------------------------------------------------------------------------

  /**
   * One chain read, many permissions answered.
   *
   * Every permission gets its own `effectiveChain`, because whether a break truncates depends on
   * the permission — `folder:manage` walks past a break that stops `document:view`. The chain
   * itself, which is the expensive part, is read once.
   */
  private async resolveMany(
    subject: AuthorizationSubject,
    scope: ScopeRef,
    permissions: readonly PermissionKey[],
  ): Promise<{
    readonly chain: readonly ChainNode[] | null;
    readonly decisions: Partial<Record<PermissionKey, Decision>>;
  }> {
    const chain = await this.chainFor(scope);
    if (chain === null) {
      return {
        chain: null,
        decisions: Object.fromEntries(permissions.map((permission) => [permission, closed()])),
      };
    }

    const roleIds = await this.roleIdsOf(subject);
    const departmentIds = await this.departmentsOf(subject);
    const subjectIds = callerSubjectIds({
      userId: String(subject.userId),
      roleIds: roleIds.map(String),
      departmentIds: departmentIds.map(String),
    });
    const granted = new Set(await this.grantedAmong(roleIds, permissions));

    const decisions: Partial<Record<PermissionKey, Decision>> = {};
    for (const permission of permissions) {
      const effective = effectiveChain(chain, permission);
      const entries = await this.entriesOnChain(effective, permission, subjectIds);
      const outcome = decideFromEntries(effective, entries, granted.has(permission));
      decisions[permission] = {
        allowed: outcome.allowed,
        decidedAt: outcome.decidedAt,
        reason: outcome.reason,
      };
    }
    return { chain, decisions };
  }

  /**
   * Step 3's single query: every entry on these nodes, for this permission.
   *
   * `subjectIds` of null is the search projection's call — it materialises the answer for callers
   * it has never seen, so it takes every subject on the chain. Bounded by the chain rather than by
   * the tenant's people: a chain is at most seven nodes deep.
   */
  private async entriesOnChain(
    effective: readonly ChainNode[],
    permission: PermissionKey,
    subjectIds: readonly string[] | null,
  ): Promise<readonly ChainEntry[]> {
    const scopeIds = effective.map((node) => String(node.scope.id));
    const records = await this.entries.listForChain(scopeIds, subjectIds, permission);
    return records.map(toChainEntry);
  }

  private async chainFor(scope: ScopeRef): Promise<readonly ChainNode[] | null> {
    const key = this.chainKey(scope);
    const cached = await this.readCache<readonly ChainNodeRecord[]>(key);
    if (cached !== null) {
      return cached;
    }
    const chain = await this.chains.chainFor(scope);
    if (chain === null) {
      return null;
    }
    await this.writeCache(key, chain);
    return chain;
  }

  /**
   * An ACL entry names a container; the list needs the documents in it.
   *
   * Organisation nodes are resolved to the libraries beneath them in one call, and folders keep
   * their materialised path — the region is "this path and everything under it", which is the same
   * `startsWith` the folder subtree filter already uses.
   */
  private async regionsFor(
    sources: readonly AclEntryRecord[],
    breaks: readonly string[],
    options: { readonly tenantWide: boolean },
  ): Promise<readonly VisibilityRegion[]> {
    const organisational = sources.filter(
      (entry) =>
        entry.scope.type === ScopeType.COMPANY ||
        entry.scope.type === ScopeType.ENTITY ||
        entry.scope.type === ScopeType.DEPARTMENT,
    );
    const tenantWide =
      options.tenantWide || sources.some((entry) => entry.scope.type === ScopeType.TENANT);
    const libraryIds = new Set(
      sources
        .filter((entry) => entry.scope.type === ScopeType.LIBRARY)
        .map((entry) => String(entry.scope.id)),
    );
    for (const id of await this.chains.librariesUnder(organisational.map((entry) => entry.scope))) {
      libraryIds.add(id);
    }
    const documentIds = sources
      .filter((entry) => entry.scope.type === ScopeType.DOCUMENT)
      .map((entry) => String(entry.scope.id));
    const folderIds = sources
      .filter((entry) => entry.scope.type === ScopeType.FOLDER)
      .map((entry) => String(entry.scope.id));

    const regions: VisibilityRegion[] = [];

    // One region for everything rooted above a folder: any break below any of them cuts, so they
    // share an exclusion list.
    if (tenantWide || libraryIds.size > 0) {
      regions.push({
        tenantWide,
        libraryIds: [...libraryIds],
        folderPaths: [],
        documentIds: [],
        excludedFolderPaths: breaks,
      });
    }
    // One region per folder: each excludes only the breaks strictly beneath it, because a break at
    // or above the granting folder cannot stop a grant made below it.
    if (folderIds.length > 0) {
      const folders = await requireTransaction().folder.findMany({
        where: { tenantId: requireContext().tenantId, id: { in: folderIds }, deletedAt: null },
        select: { path: true },
      });
      for (const folder of folders) {
        regions.push({
          tenantWide: false,
          libraryIds: [],
          folderPaths: [folder.path],
          documentIds: [],
          excludedFolderPaths: breaks.filter((path) => path.startsWith(`${folder.path}.`)),
        });
      }
    }
    // A document names itself; nothing can be broken between a node and itself.
    if (documentIds.length > 0) {
      regions.push({
        tenantWide: false,
        libraryIds: [],
        folderPaths: [],
        documentIds,
        excludedFolderPaths: [],
      });
    }
    return regions;
  }

  // --- Grants and memberships ----------------------------------------------------------------

  /**
   * The caller's roles, as identifiers.
   *
   * `AuthorizationSubject.roleIds` is filled from the request context at every call site, and the
   * context is filled from the access token, whose `roles` claim carries role **keys** —
   * `TENANT_ADMIN`, `AUTHOR`. `role_permission.role_id` and `acl_entry.subject_id` are UUIDs. The
   * two have been compared directly since Phase 8 and have never matched; nothing observed it
   * because nothing that could was running. See `AclRepository.roleIdsFor` for the whole account,
   * and the phase report for why the fix is here rather than in the token.
   */
  private async roleIdsOf(subject: AuthorizationSubject): Promise<readonly AnyId[]> {
    if (subject.roleIds.length === 0) {
      return [];
    }
    const ids = await this.entries.roleIdsFor(subject.roleIds.map(String));
    return ids.map((id) => asId<AnyId>(id));
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
   *
   * **Ancestors count.** A person in `Engineering.Platform` is a member of `Engineering` for ACL
   * purposes, because a grant to a department is understood to reach the teams inside it — the same
   * direction permission flows everywhere else in this model. Resolved from the materialised path
   * rather than by walking, so a ten-deep department costs one read.
   */
  private async departmentsOf(subject: AuthorizationSubject): Promise<readonly AnyId[]> {
    /*
     * Always computed here, never taken from the subject — Slice 24.
     *
     * This used to return `subject.departmentIds` verbatim when the caller supplied any, and that
     * branch is what produced Slice 23's defect: `RecipientVisibilityService` passed raw
     * `user_department` rows, so it skipped both the `deletedAt` filter and the path expansion
     * below and answered a different question than `AclGuard` asked for the same person.
     *
     * Slice 23 fixed the one caller. This removes the thing it fell into. A supplied list is an
     * **unvalidated authorization input**: nothing checked that the caller was a member of the
     * departments they named, so a future caller populating it from a request would have handed
     * out reach on entries naming any department whose id could be guessed. That it was not
     * reachable from production made it a trap rather than a hole, and a trap in the resolver that
     * decides ACL reach is worth closing at the source rather than by convention at fourteen call
     * sites.
     *
     * Behaviour is unchanged for every existing caller: all of them already pass `[]`. What changes
     * is that supplying a list can no longer widen anything — asserted, because "no caller does
     * this today" is not a property a test can rely on tomorrow.
     *
     * It also makes `decisionKey` honest. That key is built from the tenant, the user, the roles,
     * the scope and the permission and omits the departments; with departments derived from the
     * user rather than supplied beside them, two subjects sharing a key can no longer differ in
     * the reach they resolve to.
     */
    if (subject.userId === '') {
      return [];
    }
    // One query, through the membership relation, rather than a read of `user_department` followed
    // by a read of `department`: this runs on every list in the product, and the second round trip
    // bought nothing the join does not.
    const rows = await requireTransaction().department.findMany({
      where: {
        tenantId: requireContext().tenantId,
        deletedAt: null,
        members: { some: { userId: subject.userId } },
      },
      select: { path: true },
    });
    const ids = new Set<string>();
    for (const row of rows) {
      for (const id of idsInPath(row.path)) {
        ids.add(id);
      }
    }
    return [...ids].map((id) => asId<AnyId>(id));
  }

  // --- The cache ---------------------------------------------------------------------------

  private decisionKey(
    subject: AuthorizationSubject,
    scope: ScopeRef,
    permission: PermissionKey,
  ): string {
    const { tenantId } = requireContext();
    /*
     * The roles are in the key as well as the user, so a token minted before a role change and one
     * minted after it do not share an entry.
     *
     * `permissionVersion` is deliberately not in it, and the reason stated here until Slice 33 was
     * wrong: it said a role edit "already invalidates by prefix", and nothing does —
     * `RoleAdminService` holds no cache at all, and the only `deleteByPrefix('acl:<tenant>:')` in
     * the product is `AclPermissionService.afterChange`, which runs on ACL entry and inheritance
     * writes.
     *
     * What actually makes the omission safe is that a role's permission set reaches a decision only
     * through step 6's tenant-wide grant, and `RbacGuard` gates every route on that same grant
     * before this resolver is asked — from the token's `permissions` claim, which a role edit
     * rewrites and which Slice 31 made refusable when it is stale. So a decision cached under an
     * unchanged set of role *ids* cannot let a route through that `RbacGuard` would refuse.
     *
     * What a stale entry can still do is answer `capabilitiesFor` — the capability list a screen
     * draws its buttons from — with a permission the role has just lost, for the length of the ACL
     * TTL. That offers an action the next request then refuses; it grants nothing.
     */
    const roles = [...subject.roleIds].map(String).sort().join(',');
    return `acl:${tenantId}:d:${String(subject.userId)}:${roles}:${scope.type}:${String(scope.id)}:${permission}`;
  }

  private filterKey(subject: AuthorizationSubject, permission: PermissionKey): string {
    const { tenantId } = requireContext();
    const roles = [...subject.roleIds].map(String).sort().join(',');
    return `acl:${tenantId}:v:${String(subject.userId)}:${roles}:${permission}`;
  }

  /**
   * The one definition of the tenant's cache namespace — Slice 34.
   *
   * Every key below is built from it and `invalidateTenant` clears it, so the two cannot drift.
   * `AclPermissionService.afterChange` spelled the same string a second time until this existed.
   */
  private tenantPrefix(): string {
    return `acl:${requireContext().tenantId}:`;
  }

  async invalidateTenant(): Promise<void> {
    await this.cache.deleteByPrefix(this.tenantPrefix());
  }

  private chainKey(scope: ScopeRef): string {
    return `acl:${requireContext().tenantId}:c:${scope.type}:${String(scope.id)}`;
  }

  private async readCache<TValue>(key: string): Promise<TValue | null> {
    if (this.config.acl.cacheTtlSeconds === 0) {
      return null;
    }
    return this.cache.get<TValue>(key);
  }

  private async writeCache<TValue>(key: string, value: TValue): Promise<void> {
    if (this.config.acl.cacheTtlSeconds === 0) {
      return;
    }
    await this.cache.set(key, value, this.config.acl.cacheTtlSeconds);
  }
}

function toChainEntry(record: AclEntryRecord): ChainEntry {
  return {
    scopeId: String(record.scope.id),
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    effect: record.effect,
  };
}

function closed(): Decision {
  return { allowed: false, decidedAt: null, reason: 'CLOSED_BY_DEFAULT' };
}
