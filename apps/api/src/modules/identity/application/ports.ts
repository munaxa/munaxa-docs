import type {
  AnyId,
  DelegationEdge,
  DelegationId,
  DelegationKindKey,
  DelegationRefusalKey,
  DelegationStatusKey,
  PermissionKey,
  RoleId,
  TenantId,
  UserId,
  UserStatusKey,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Identity's persistence and application contracts.
 *
 * Repositories return domain objects and are aggregate-scoped: `UserRepository` loads what a
 * user's invariants need, not everything an admin screen shows. Screens are served by query
 * services (`docs/architecture/02-backend-architecture.md` §5).
 */
export const USER_REPOSITORY = Symbol('UserRepository');
export const ROLE_REPOSITORY = Symbol('RoleRepository');
export const DELEGATION_REPOSITORY = Symbol('DelegationRepository');
export const SESSION_REPOSITORY = Symbol('SessionRepository');

export interface UserRecord {
  readonly id: UserId;
  readonly email: string;
  readonly status: UserStatusKey;
  readonly mfaEnrolled: boolean;
  readonly roleIds: readonly RoleId[];
  readonly departmentIds: readonly AnyId[];
}

export interface UserRepository {
  findById(id: UserId): Promise<UserRecord | null>;
  /** Case-insensitive, live rows only: a deleted user never blocks a re-invitation. */
  findByEmail(email: string): Promise<UserRecord | null>;
  save(user: UserRecord): Promise<void>;
  list(page: PageRequest): Promise<Page<UserRecord>>;
}

export interface RoleRecord {
  readonly id: RoleId;
  readonly key: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly permissions: readonly PermissionKey[];
}

export interface RoleRepository {
  findById(id: RoleId): Promise<RoleRecord | null>;
  /** Seeded roles are found by their `SystemRole` key; tenant-defined ones by their own. */
  findByKey(key: string): Promise<RoleRecord | null>;
  save(role: RoleRecord): Promise<void>;
  listAll(): Promise<readonly RoleRecord[]>;
}

/**
 * One delegation, as the use case holds it.
 *
 * The Phase 0.5 sketch of this interface carried six fields and was bound to nothing. It is
 * widened rather than replaced, because the six it guessed at were all right — and the shape it
 * was missing is the whole of what §4 turned out to require: who agreed to it, whether it was
 * declared rather than requested, how deep in a chain it sits, and what became of it.
 *
 * `permissions` is what the delegator chose to pass, and deliberately **not** a snapshot of what
 * they held. §4 checks authority at decision time; a copy of the delegator's grants taken at
 * creation is precisely the "checked at creation" the section forbids, and it would go stale in
 * the direction that matters — a role withdrawn afterwards would still authorise.
 */
export interface DelegationRecord {
  readonly id: DelegationId;
  readonly delegatorId: UserId;
  readonly delegateId: UserId;
  readonly kind: DelegationKindKey;
  readonly status: DelegationStatusKey;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly permissions: readonly PermissionKey[];
  readonly reason: string | null;
  readonly depth: number;
  readonly requestedAt: Date;
  readonly approvedById: UserId | null;
  readonly approvedAt: Date | null;
  readonly declineReason: string | null;
  readonly revokedById: UserId | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
  readonly version: number;
}

/** A delegation with the names and the use count the screens render. */
export interface DelegationView extends DelegationRecord {
  readonly delegatorName: string | null;
  readonly delegateName: string | null;
  readonly approvedByName: string | null;
  /** How many decisions were taken under it — §4's visibility rule, as a number. */
  readonly useCount: number;
}

/** One decision taken under a delegation, projected from `approval_task`. */
export interface DelegationUseRecord {
  readonly taskId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly documentNumber: string | null;
  readonly decision: string | null;
  readonly decidedById: UserId;
  readonly decidedByName: string | null;
  readonly onBehalfOfId: UserId;
  readonly decidedAt: Date | null;
}

export interface DelegationRepository {
  findById(id: DelegationId): Promise<DelegationRecord | null>;
  /**
   * Takes a row lock, and returns false when there is no such delegation.
   *
   * Every write path calls it first, for the reason the workflow engine locks its instance: a
   * revocation and an approval arriving at the same instant would otherwise both read
   * `PENDING_APPROVAL` and both write, and the second would silently undo the first.
   */
  lock(id: DelegationId): Promise<boolean>;
  /**
   * In force for this delegate at this instant.
   *
   * The authority predicate's own read, and the only one on a request's hot path. "At this
   * instant" is a parameter rather than `now()` because the same question is asked of a past date
   * by a report, and two implementations of "was this in force" would be two answers.
   */
  listActiveFor(delegateId: UserId, at: Date): Promise<readonly DelegationRecord[]>;
  /**
   * Every delegation in force in the tenant, as chain edges.
   *
   * A whole-tenant read for one decision, and the right shape anyway: a cycle is a property of the
   * graph rather than of any pair in it. The graph is tiny — a delegation is a temporary
   * arrangement a handful of people have at any moment, not a row per document.
   */
  liveEdges(at: Date): Promise<readonly DelegationEdge[]>;
  /** Delegations in force whose period has ended — the sweep's read, oldest first. */
  listEndedButActive(at: Date, limit: number): Promise<readonly DelegationRecord[]>;

  create(delegation: DelegationRecord): Promise<void>;
  /**
   * Moves a delegation to a new status only if it is still in the one the caller read.
   *
   * Returns false when zero rows matched, which means somebody moved it first. A conflict rather
   * than an overwrite: approving a delegation somebody revoked a moment ago would put an authority
   * back that its delegator had taken away, and that is the one race in this module worth making
   * impossible rather than unlikely.
   */
  transition(input: {
    readonly id: DelegationId;
    readonly from: readonly DelegationStatusKey[];
    readonly to: DelegationStatusKey;
    readonly at: Date;
    readonly approvedById?: UserId | null;
    readonly declineReason?: string | null;
    readonly revokedById?: UserId | null;
    readonly revokeReason?: string | null;
  }): Promise<boolean>;

  // --- The read side ---
  list(request: DelegationListRequest): Promise<Page<DelegationView>>;
  usesOf(id: DelegationId): Promise<readonly DelegationUseRecord[]>;
}

export interface DelegationListRequest extends PageRequest {
  /** Whose list, and from which side. Never absent: a delegation list with no subject is a register. */
  readonly userId: UserId;
  readonly direction: 'GIVEN' | 'RECEIVED' | 'AWAITING_MY_APPROVAL';
  readonly status?: DelegationStatusKey | undefined;
  readonly includeEnded: boolean;
  /**
   * Whose requests this caller may approve, for `AWAITING_MY_APPROVAL`.
   *
   * Passed in rather than resolved here because "who may approve this" is the phase's own decision
   * and it is made in the service — the repository's job is to filter, not to hold a policy.
   */
  readonly approvableDelegatorIds?: readonly UserId[] | undefined;
}

/**
 * A stored refresh token, as the rotation logic needs to see it.
 *
 * `usedAt` and the family's `revokedAt` are both carried because they mean different things:
 * a used token is evidence of replay, a revoked family is a session that is already over.
 */
export interface RefreshTokenRecord {
  readonly id: AnyId;
  readonly familyId: AnyId;
  readonly userId: UserId;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly familyRevokedAt: Date | null;
}

export interface SessionRepository {
  /** Opens a session family. One sign-in, one family, however many rotations follow. */
  createFamily(family: {
    readonly id: AnyId;
    readonly userId: UserId;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  }): Promise<void>;
  /** Records an issued refresh token. Only the hash is stored — never the token itself. */
  issueToken(token: {
    readonly id: AnyId;
    readonly familyId: AnyId;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void>;
  /** Refresh tokens are stored hashed; reuse of a rotated token kills the whole family. */
  findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /**
   * Marks a token exchanged. Returns false when it was already marked, which is the signal
   * that this is a replay — the caller revokes the family rather than issuing a new pair.
   */
  markUsed(tokenId: AnyId, at: Date): Promise<boolean>;
  revokeFamily(familyId: AnyId, reason: string): Promise<void>;
  revokeAllForUser(userId: UserId, reason: string): Promise<void>;
}

/**
 * Everything sign-in needs about a user, in one read.
 *
 * Separate from `UserRecord` because it carries the password hash, which must not travel on
 * the type that administrative screens use — the narrower the audience for a credential, the
 * fewer places it can be logged from.
 */
export interface UserCredentialRecord {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatusKey;
  readonly passwordHash: string | null;
  readonly mfaEnrolled: boolean;
  readonly permissionVersion: number;
  readonly roleIds: readonly RoleId[];
  readonly roleKeys: readonly string[];
  readonly permissions: readonly PermissionKey[];
}

export const CREDENTIAL_REPOSITORY = Symbol('CredentialRepository');

/**
 * Credential reads and writes, kept apart from `UserRepository` on purpose: this is the only
 * interface in the module that can see a password hash.
 */
export interface CredentialRepository {
  /** Case-insensitive, live rows only. Null for unknown, deleted, or wrong-tenant. */
  findByEmail(email: string): Promise<UserCredentialRecord | null>;
  findById(id: UserId): Promise<UserCredentialRecord | null>;
  updatePasswordHash(id: UserId, encodedHash: string, at: Date): Promise<void>;
  recordSignIn(id: UserId, at: Date): Promise<void>;
}

export const PROVISIONING_REPOSITORY = Symbol('ProvisioningRepository');

/**
 * The writes that bootstrap a tenant.
 *
 * Separate from the repositories above because it is the only one that runs *before* a tenant
 * exists, and because narrowing it is what keeps a bootstrap path from quietly becoming a
 * second way to create users.
 */
export interface ProvisioningRepository {
  /**
   * Whether this tenant's database already holds its tenant row.
   *
   * Replaces the slug-uniqueness check Phase 1 had. Uniqueness is now the registry's, checked at boot
   * across the whole catalogue; what is left to ask here is whether *this* database has already been
   * provisioned — a question only its own database can answer
   * (`docs/architecture/adr/0015-database-per-tenant.md`).
   */
  alreadyProvisioned(tenantId: TenantId): Promise<boolean>;
  createTenant(tenant: { id: TenantId; slug: string; name: string }): Promise<void>;
  /**
   * The root of the scope tree.
   *
   * A tenant with no company has nowhere to put a department, and the ACL chain has nothing
   * between the tenant and a library. Both are created here so the tree is usable from the
   * first sign-in; they are ordinary configuration afterwards, renamed and extended in Phase 2.
   */
  createRootScope(scope: {
    readonly companyId: AnyId;
    readonly entityId: AnyId;
    readonly code: string;
    readonly name: string;
  }): Promise<void>;
  /**
   * The eight roles every tenant starts with, and their seeded permissions.
   *
   * All eight rather than only the administrator's, because a tenant with one role is a tenant that
   * cannot delegate anything: an administrator's first act is to make somebody an author, and having
   * to create the role first turns "add a colleague" into a matrix-design exercise. The seeds come
   * from `08-permission-model.md` §6 via `domain/role-seed.ts`, and they are ordinary tenant data
   * the moment they are written.
   */
  createSystemRoles(
    roles: readonly {
      readonly id: RoleId;
      readonly key: string;
      readonly name: string;
      readonly description: string;
      readonly permissions: readonly PermissionKey[];
    }[],
  ): Promise<void>;
  createAdminUser(user: {
    id: UserId;
    roleId: RoleId;
    email: string;
    emailNormalized: string;
    displayName: string;
    passwordHash: string;
  }): Promise<void>;
}

export const USER_DIRECTORY = Symbol('UserDirectory');

/** Enough to address a person. Deliberately not enough to do anything else with them. */
export interface UserContact {
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string;
}

/**
 * How other modules look up who to write to.
 *
 * Narrower than `UserService` on purpose: Notification needs an address and a name, and giving
 * it the full user surface would let it grow a dependency on things that are none of its
 * business. This is the whole of the contract, and it is the only way out of this module —
 * nobody reads Identity's tables (`docs/architecture/02-backend-architecture.md` §3).
 *
 * There is no locale here. A person's language is tenant configuration today, resolved through
 * `SETTINGS_READER`; when users get their own preference it is added here and every caller
 * keeps working.
 */
export interface UserDirectory {
  contactFor(userId: UserId): Promise<UserContact | null>;
  /** Live users only, in one query — a notification to twenty people is not twenty round trips. */
  contactsFor(userIds: readonly UserId[]): Promise<readonly UserContact[]>;

  // -------------------------------------------------------------------------------------
  // Routing lookups — Phase 4.
  //
  // The workflow engine resolves a stage's participants at activation (`07-workflow-architecture.md`
  // §2), and four of the seven resolver kinds are questions about *people*: who holds this role
  // here, who belongs to this department, who manages this person, and which of these accounts is
  // still active.
  //
  // They are added to this port rather than answered by a workflow repository reading `user` and
  // `user_role`, because this interface is the whole of what other modules may know about a person
  // and "nobody reads Identity's tables" is a rule with no exceptions in it. Every one of them is a
  // read, returns identifiers, and is asked at a moment — none is cached, because a workflow that
  // cached who a manager was would route an approval to somebody who left.
  // -------------------------------------------------------------------------------------

  /**
   * Everybody holding a role, optionally narrowed to one part of the organisation.
   *
   * `scope` narrows by the *user's* department or entity, which is what "the quality manager for
   * this entity" means: roles are granted tenant-wide and the scope is where the holder sits. A
   * scope naming a node that does not exist narrows to nobody rather than widening to the tenant —
   * widening would silently route an approval meant for one department to every department.
   */
  holdersOfRole(roleKey: string, scope: DirectoryScope): Promise<readonly UserId[]>;

  /** A department's members, or only the ones who manage it. */
  membersOfDepartment(departmentId: string, managersOnly: boolean): Promise<readonly UserId[]>;

  /**
   * Whoever manages this person.
   *
   * The managers of their **primary** department, falling back to every department they belong to
   * when they have no primary one. A person can have two managers and that is an ordinary
   * arrangement, so this returns a list rather than picking one — and the workflow that asks
   * creates a task for each, which its completion rule then counts.
   *
   * A person who manages their own department is excluded from their own result: "escalate to my
   * manager" resolving to me is an escalation that goes nowhere and hides that nobody is above me.
   */
  managersOf(userId: UserId): Promise<readonly UserId[]>;

  /**
   * Whoever this person manages — `managersOf` asked in the other direction. Phase 11's addition.
   *
   * The members of every department this person manages, excluding themselves for the reason
   * `managersOf` excludes them: somebody who manages their own department is not their own
   * subordinate, and a queue that said otherwise would show a manager their own request.
   *
   * It exists because a delegation's approval queue is the inverse of its approval rule. The rule
   * is "a manager of the delegator may agree"; the queue is "whose requests may I agree to". Both
   * have to read the same relationship or the queue shows a request the approval then refuses, and
   * deriving one from the other in the caller would mean loading every pending delegation in the
   * tenant and asking `managersOf` per row.
   */
  subordinatesOf(userId: UserId): Promise<readonly UserId[]>;

  /** Which of these are live and active. The filter every resolver ends with. */
  activeAmong(userIds: readonly UserId[]): Promise<readonly UserId[]>;

  /**
   * Everybody who holds a permission through any of their roles — Phase 12's addition.
   *
   * It exists because two notifications in 18 §4 are addressed to a *capability* rather than to
   * a person or a role: "administrators" for a security event, and the document controller for a
   * retention one. `holdersOfRole` cannot answer either without the caller naming role keys in
   * code, which is the coupling `07-workflow-architecture.md` §8 forbids the workflow engine and
   * which would be no better here — a tenant that renames its controller role would silently
   * stop being told its audit chain had broken.
   *
   * A permission, by contrast, is a catalogue entry: it cannot be renamed by a tenant, and "who
   * may manage users" is exactly the question "who should be told an address was suppressed" is
   * asking. Roles are still where the grant lives; this walks from the permission back to them.
   */
  holdersOfPermission(permission: PermissionKey): Promise<readonly UserId[]>;

  /**
   * A person's own authorisation subject — their roles and departments — Phase 12's second
   * addition.
   *
   * It is here rather than on `USER_SERVICE`, which declares a `subjectsFor` and has been bound
   * to nothing since Phase 0.5, for one reason: every caller of that symbol would have to be a
   * caller of a service that does not exist, and binding it would mean building a user
   * *aggregate* repository to answer a two-join read. This port already answers "who is this
   * person, organisationally" — which departments, which roles, who manages them — and a subject
   * is the same question asked in the vocabulary the ACL resolver speaks.
   *
   * The delegations are deliberately **not** here. 08 §3 lost its "active delegations" clause in
   * Phase 11 rather than the resolver gaining a subject, so a subject carries none — and a
   * notification recipient's visibility must not depend on cover they were given, which would
   * make a delegation the permission grant 07 §4 says it must never be.
   */
  authorizationSubjectFor(userId: UserId): Promise<{
    readonly roleIds: readonly RoleId[];
  } | null>;
}

/** Where a role lookup looks. `nodeId` is null for `TENANT`, and only for it. */
export interface DirectoryScope {
  readonly kind: 'TENANT' | 'ENTITY' | 'DEPARTMENT';
  readonly nodeId: string | null;
}

export const USER_SERVICE = Symbol('UserService');
export const DELEGATION_SERVICE = Symbol('DelegationService');

/** The surface other modules call. They never reach into Identity's repositories. */
export interface UserService {
  get(id: UserId): Promise<UserRecord | null>;
  /** Subjects an authorisation decision is resolved against: user, roles, departments. */
  subjectsFor(
    id: UserId,
    at: Date,
  ): Promise<{
    readonly userId: UserId;
    readonly roleIds: readonly RoleId[];
    readonly departmentIds: readonly AnyId[];
    readonly delegationIds: readonly DelegationId[];
  }>;
}

/**
 * Whether one person may act for another, right now, on one permission — and under which
 * delegation.
 *
 * `null` for the delegation when nobody may, with `refusal` saying which rule refused. The pair
 * rather than a boolean because a refusal that cannot say *why* is a refusal an approver reads as
 * "the system is broken": "your delegation ended on Friday" and "Alice no longer holds
 * `document:approve`" are two different sentences and two different things to go and fix.
 */
export interface DelegationAuthority {
  readonly delegation: DelegationRecord | null;
  readonly refusal: DelegationRefusalKey | null;
}

/**
 * The surface other modules call. They never reach into Identity's repositories.
 *
 * `authorityFor` is the whole of what Workflow needs, and its shape is §4's central rule made
 * unavoidable: the *permission* is a parameter, and the answer is computed from the delegator's
 * grants **as they are at `at`** rather than from anything stored on the delegation. A caller
 * cannot ask a cheaper question — there is no `isDelegate(a, b)` here — because the cheaper
 * question is the one that lets a delegate exceed the delegator's authority.
 *
 * It lives in Identity rather than in the ACL resolver deliberately, and the decision is recorded
 * in `docs/reports/phase-11-delegation.md`. `PrismaAclResolver` answers "may this subject reach
 * this node", walking a scope chain; "what does this person hold tenant-wide right now" is a
 * different question with a different answer, and Identity is what owns users, roles and the
 * permission sets they resolve to. Routing it through the ACL resolver would also make a
 * delegation an ACL *subject*, which would turn a routing overlay into a grant — the one thing §4
 * says it must never be.
 */
export interface DelegationService {
  /** In force for this person at this instant, in either direction of the arrangement. */
  listActive(userId: UserId, at: Date): Promise<readonly DelegationRecord[]>;
  /**
   * May `delegateId` exercise `permission` on behalf of `delegatorId` at `at`?
   *
   * Called inside the deciding transaction, so the delegation it returns is the one the decision
   * is written with — a revocation committed a moment earlier is already visible, and one arriving
   * a moment later waits on the approval instance's lock.
   */
  authorityFor(input: {
    readonly delegateId: UserId;
    readonly delegatorId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<DelegationAuthority>;
  /**
   * Everybody this person may currently act for, given one permission.
   *
   * The inbox's read: "show me exactly what I may act on and nothing more". It answers with the
   * delegators rather than with tasks, because which tasks follow from that is Workflow's
   * question and Identity has no business knowing what an approval task is.
   */
  delegatorsFor(input: {
    readonly delegateId: UserId;
    readonly permission: PermissionKey;
    readonly at: Date;
  }): Promise<readonly DelegationRecord[]>;
}

export const FEDERATED_USER_REPOSITORY = Symbol('FederatedUserRepository');

/**
 * Reads and writes the four columns Phase 17 added to `user`, and nothing else.
 *
 * A separate interface from `UserRepository` and from `CredentialRepository` for the reason those
 * two are separate from each other: this is the only one that can *create a person without an
 * administrator having asked for it*, which is a capability worth being able to find every caller
 * of. `UserAdminService` is where an administrator creates somebody, and nothing here grows into
 * it — there is no update, no delete, no list.
 */
export interface FederatedUserRepository {
  /**
   * The account this assertion belongs to, by external subject first and by address second.
   *
   * Both, in that order, and the order is the whole of it. **The subject is the identity**: a
   * person who changes their email address at the provider is the same person, and matching on
   * address alone would provision them a second account. The address is the *fallback*, and it
   * exists so that a tenant switching on federation binds its existing accounts to the provider on
   * each person's first federated sign-in rather than duplicating all of them.
   *
   * The address fallback is safe only because the assertion is a verified ID token from the
   * provider that owns the domain: an attacker cannot claim `ada@acme.com` at a provider that
   * answers for `acme.com` without controlling that account.
   */
  findByExternalIdentity(
    providerId: AnyId,
    externalId: string,
    emailNormalized: string,
  ): Promise<UserId | null>;

  /** Binds an existing local account to the provider on its holder's first federated sign-in. */
  linkToProvider(
    id: UserId,
    providerId: AnyId,
    externalId: string,
    displayName: string,
    at: Date,
  ): Promise<void>;

  /**
   * Creates a person from a verified assertion — 17 §2's JIT provisioning.
   *
   * `roleKeys` are the pre-mapped ones and are resolved to this tenant's roles here; a key that
   * matches no role is **dropped rather than created**, because a provider that could bring a new
   * role into existence would be a provider that decides this tenant's permission model.
   *
   * No password hash is written, and `identity_source` is `FEDERATED` — which together are what
   * make "this account has no password because it federates" distinguishable from "this account
   * has no password because nobody has accepted the invitation", a distinction the product could
   * not make before this phase.
   *
   * Answers whether *this* call created the account. Two callbacks carrying one new subject both
   * read it absent and both arrive here, and `uq_user_external_identity` lets exactly one of them
   * write. A caller told `false` lost that race and is in the position of one that arrived second
   * in order: the account exists, and signing in against it is what the sequential path does.
   */
  provision(input: {
    readonly id: UserId;
    readonly email: string;
    readonly emailNormalized: string;
    readonly displayName: string;
    readonly providerId: AnyId;
    readonly externalId: string;
    readonly roleKeys: readonly string[];
    readonly at: Date;
  }): Promise<boolean>;
}
