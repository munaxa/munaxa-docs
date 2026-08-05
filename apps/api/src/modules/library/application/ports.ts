import type {
  AclEffectKey,
  AclSubjectTypeKey,
  AnyId,
  FolderId,
  LibraryId,
  PermissionKey,
  ScopeRef,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

export const LIBRARY_REPOSITORY = Symbol('LibraryRepository');
export const FOLDER_REPOSITORY = Symbol('FolderRepository');
export const ACL_REPOSITORY = Symbol('AclRepository');

export interface LibraryRecord {
  readonly id: LibraryId;
  readonly code: string;
  readonly name: string;
  readonly ownerScope: ScopeRef;
  readonly rootFolderId: FolderId;
}

export interface LibraryRepository {
  findById(id: LibraryId): Promise<LibraryRecord | null>;
  findByCode(code: string): Promise<LibraryRecord | null>;
  save(library: LibraryRecord): Promise<void>;
  list(page: PageRequest): Promise<Page<LibraryRecord>>;
}

export interface FolderRecord {
  readonly id: FolderId;
  readonly libraryId: LibraryId;
  readonly parentId: FolderId | null;
  readonly name: string;
  readonly path: string;
  /** When false, the ACL walk stops here — except for administrative permissions. */
  readonly inheritAcl: boolean;
}

export interface FolderRepository {
  findById(id: FolderId): Promise<FolderRecord | null>;
  listChildren(id: FolderId): Promise<readonly FolderRecord[]>;
  /** Ancestor-first, from the materialised path: one query, whatever the depth. */
  listAncestors(id: FolderId): Promise<readonly FolderRecord[]>;
  save(folder: FolderRecord): Promise<void>;
  /** Moving a subtree rewrites descendant paths; the caller's transaction covers all of it. */
  moveSubtree(id: FolderId, newParentId: FolderId): Promise<void>;
}

export interface AclEntryRecord {
  readonly scope: ScopeRef;
  readonly subjectType: AclSubjectTypeKey;
  readonly subjectId: string;
  readonly permission: PermissionKey;
  readonly effect: AclEffectKey;
}

/** An entry as it is read back for administration: the record, plus who made it and when. */
export interface StoredAclEntry extends AclEntryRecord {
  readonly id: AnyId;
  readonly createdAt: Date;
  readonly createdBy: string | null;
}

export interface AclRepository {
  /**
   * Every entry on a scope chain, for the subjects given: the resolver's single query.
   *
   * Filtered by permission as well, because a chain of seven nodes for a caller with four
   * subjects is a small set only when the permission narrows it — a library manager's node can
   * carry an entry per permission in the catalogue, and reading all thirty-seven to answer one
   * would make the hottest query in the product thirty-seven times wider than it needs to be.
   *
   * `subjectIds` of **null** means every subject, and it has exactly one caller: the search
   * projection, which materialises an entry's answer for callers it has never seen. An empty
   * array means no subject and matches nothing — the two are different questions and the type
   * says so, because spelling "everyone" as `[]` is how a filter goes missing.
   */
  listForChain(
    scopeIds: readonly string[],
    subjectIds: readonly string[] | null,
    permission: PermissionKey,
  ): Promise<readonly AclEntryRecord[]>;
  /**
   * Every entry in the tenant naming any of these subjects, for one permission.
   *
   * `visibilityFilter`'s query: the list predicate is built by asking "where does this caller
   * reach", which is a question about the subject rather than about a chain. Bounded by
   * `acl.maxSubjectEntries`; a caller past the bound degrades closed (see the resolver).
   */
  listForSubjects(
    subjectIds: readonly string[],
    permission: PermissionKey,
    limit: number,
  ): Promise<readonly AclEntryRecord[]>;
  /** Every entry on one node, whatever the permission — the permissions screen's explicit tab. */
  listForScope(scope: ScopeRef): Promise<readonly StoredAclEntry[]>;
  /**
   * Replaces one node's entries with exactly these, and says what changed.
   *
   * One method rather than `grant` and `revoke`, because the screen edits a matrix and posts the
   * matrix: a pair of calls would leave a window in which a node had the new denies and not yet
   * the new allows, and that window is a disclosure. The returned diff is what the two audit
   * actions are written from — the caller cannot compute it without re-reading, and re-reading
   * outside the transaction would race the write it is describing.
   */
  replaceForScope(
    scope: ScopeRef,
    entries: readonly AclEntryRecord[],
  ): Promise<{
    readonly granted: readonly AclEntryRecord[];
    readonly revoked: readonly AclEntryRecord[];
  }>;
  /** Removes every entry on a node, for the delete path. Returns what it removed. */
  deleteForScope(scope: ScopeRef): Promise<readonly AclEntryRecord[]>;

  /**
   * `folder.inherit_acl`, read and written.
   *
   * On the ACL repository rather than the folder one because the column is not a property of the
   * folder in any sense the folder screen cares about — it is an ACL rule that happens to be stored
   * on the folder row, and it is read by the walk and written by the permissions screen. Keeping it
   * beside the entries is what stops "who may break inheritance" from drifting away from "who may
   * grant".
   */
  findInheritance(folderId: FolderId): Promise<InheritanceRecord | null>;
  setInheritance(folderId: FolderId, inherit: boolean): Promise<void>;

  /**
   * The roles one person holds, for `effectiveFor`.
   *
   * Here for the reason `PrismaAclResolver` reads `role_permission` and `user_department` directly:
   * `08` names the resolution "the only place a decision is made", and a decision assembled from
   * three application services would put the algorithm's pieces in three modules. Editing those
   * tables stays Identity's; deciding with them happens here. Returns null when the user does not
   * exist, which the caller turns into a `404`.
   */
  rolesOf(userId: string): Promise<readonly string[] | null>;

  /**
   * Role identifiers for whatever the caller's context happens to carry.
   *
   * **This exists because of a defect Phase 14 found by finally exercising the resolver.** A JWT
   * carries `roles` as role *keys* — `authentication.service.ts` fills the claim from
   * `credential.roleKeys`, and it has since Phase 1 — while `role_permission.role_id` and an ACL
   * entry's `subject_id` are both UUIDs. `PrismaAclResolver` has compared the two directly since
   * Phase 8 and matched nothing, which was invisible for six phases because nothing that could
   * *observe* a grant ran with a non-empty role list: `AclGuard` was never bound to a route, and
   * every suite that touches the resolver builds its subject with `roles: []`. Putting `@ScopedTo`
   * on the object routes is what made it fire, which is exactly the discovery Phase 9's limit row
   * predicted would arrive with it.
   *
   * Resolved here rather than at each call site, because there are six of them and a key-to-id
   * translation repeated six times is five chances to get it wrong. Accepts ids as well as keys, so
   * a caller that already holds ids — `PermissionService.effectiveFor` reads `user_role` — needs no
   * special case.
   */
  roleIdsFor(keysOrIds: readonly string[]): Promise<readonly string[]>;
}

export interface InheritanceRecord {
  readonly id: FolderId;
  readonly name: string;
  readonly inheritAcl: boolean;
  readonly version: number;
}

export const SCOPE_CHAIN_READER = Symbol('ScopeChainReader');

/**
 * Reads the chain a decision is made over: the object, its ancestors, and the tenant.
 *
 * Its own port rather than a method on `AclRepository` because it reads *four* tables that have
 * nothing to do with ACL entries — `document`, `folder`, `library` and the organisation tree — and
 * because it is the half of the walk whose cost is bounded by the tree's depth rather than by the
 * number of grants. Splitting them is what lets the resolver cache the expensive half.
 */
export interface ScopeChainReader {
  /**
   * The chain for one object, ancestor-first, tenant at index 0.
   *
   * Returns null when the object does not exist — which is how a cross-scope read becomes a `404`
   * rather than a `403`: the guard cannot distinguish "no such document" from "not yours", and
   * `08 §7` requires that it must not.
   */
  chainFor(scope: ScopeRef): Promise<readonly ChainNodeRecord[] | null>;
  /**
   * Every library reachable beneath these organisation nodes, plus those owned by them directly.
   *
   * `visibilityFilter` needs it: an `ALLOW` on a department has to become a `WHERE` over documents,
   * and documents are reached through libraries. Resolved here, once, rather than in every list
   * that filters — see `VisibilityRegion`'s own note on why.
   */
  librariesUnder(scopes: readonly ScopeRef[]): Promise<readonly string[]>;
  /** Every folder in the tenant that breaks inheritance, by materialised path. */
  brokenInheritancePaths(): Promise<readonly string[]>;
}

/** One node of a chain, as the reader produces it. */
export interface ChainNodeRecord {
  readonly scope: ScopeRef;
  readonly breaksInheritance: boolean;
  readonly path: string | null;
  /** For rendering "the node that decided it" without a second round of lookups. */
  readonly name: string;
}

export const LIBRARY_SERVICE = Symbol('LibraryService');
export const PERMISSION_SERVICE = Symbol('PermissionService');

export interface LibraryService {
  get(id: LibraryId): Promise<LibraryRecord | null>;
  folderExists(id: FolderId): Promise<boolean>;
}

/**
 * Explicit and effective permissions for a scope node. The permissions tab shows *why* a
 * user has access — which node decided it — not merely that they do
 * (`docs/architecture/16-frontend-architecture.md` §5).
 *
 * ADR-0005 asks for this by name, as the mitigation for its own consequence: "a `DENY` is a blunt
 * instrument and administrators must be told so — the UI shows, for any user and object, the
 * **effective** permission and the **node that decided it**." `Decision.decidedAt` has carried that
 * field since Phase 0.5 with nothing reading it. This is its reader.
 */
export interface PermissionService {
  /**
   * The entries written *on this node*, and the chain the node sits on.
   *
   * Nothing inherited among the entries — this is the editable set. The chain comes with them
   * because whether something above has stopped inheriting is a fact about the node rather than
   * about any person, and the screen must be able to show it before anybody has been named.
   */
  explicitFor(scope: ScopeRef): Promise<ExplicitAcl>;
  /**
   * What one person actually holds on one object, permission by permission, with the node that
   * decided each and the rule that did it.
   *
   * A user id rather than an arbitrary subject: "why can Ahmed see this" is the question an
   * administrator asks, and answering it for a role would answer a question nobody has — a role
   * has no departments and no other roles, so it is not a subject the walk can resolve for.
   */
  effectiveFor(scope: ScopeRef, userId: string): Promise<EffectivePermissions>;
  /** Replaces one node's explicit entries, audited. Returns the node's new explicit set. */
  replaceFor(scope: ScopeRef, entries: readonly AclEntryDraft[]): Promise<ExplicitAcl>;
  /** Sets `folder.inherit_acl`, audited as `INHERITANCE_BROKEN` when it goes false. */
  setInheritance(folderId: FolderId, inherit: boolean, expectedVersion?: number): Promise<boolean>;
}

/** An entry as an administrator posts it — no id, no stamps; the node comes from the route. */
export interface AclEntryDraft {
  readonly subjectType: AclSubjectTypeKey;
  readonly subjectId: string;
  readonly permission: PermissionKey;
  readonly effect: AclEffectKey;
}

export interface ExplicitAcl {
  readonly entries: readonly StoredAclEntry[];
  readonly chain: readonly ChainNodeRecord[];
  readonly inheritanceBroken: boolean;
  /** Set only when the node is a folder — only a folder carries the inheritance flag. */
  readonly folderId: FolderId | null;
  readonly folderInheritsAcl: boolean | null;
}

export interface EffectivePermission {
  readonly permission: PermissionKey;
  readonly allowed: boolean;
  /** Which node decided, and what it is called — ADR-0005's "and the node that decided it". */
  readonly decidedAt: ScopeRef | null;
  readonly decidedAtName: string | null;
  readonly reason: 'ALLOW' | 'DENY' | 'ROLE_GRANT' | 'CLOSED_BY_DEFAULT';
}

export interface EffectivePermissions {
  readonly scope: ScopeRef;
  readonly userId: string;
  readonly permissions: readonly EffectivePermission[];
  /**
   * The chain the answers were resolved over, ancestor-first, already truncated by any inheritance
   * break. Rendering it is how an administrator sees that a break is *why* the tenant grant stopped
   * applying, instead of inferring it from an unexpected refusal.
   */
  readonly chain: readonly {
    readonly scope: ScopeRef;
    readonly name: string;
    readonly breaksInheritance: boolean;
  }[];
  /** True when a folder on the full chain breaks inheritance, whether or not it truncated. */
  readonly inheritanceBroken: boolean;
}
