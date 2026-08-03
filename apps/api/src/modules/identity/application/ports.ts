import type {
  AnyId,
  DelegationId,
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

export interface DelegationRecord {
  readonly id: DelegationId;
  readonly delegatorId: UserId;
  readonly delegateId: UserId;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly permissions: readonly PermissionKey[];
}

export interface DelegationRepository {
  findById(id: DelegationId): Promise<DelegationRecord | null>;
  /** Active at a point in time — the resolver asks for "now", a report asks for a past date. */
  listActiveFor(userId: UserId, at: Date): Promise<readonly DelegationRecord[]>;
  save(delegation: DelegationRecord): Promise<void>;
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

export interface DelegationService {
  listActive(userId: UserId, at: Date): Promise<readonly DelegationRecord[]>;
}
