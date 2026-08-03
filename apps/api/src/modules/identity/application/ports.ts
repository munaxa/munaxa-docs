import type {
  AnyId,
  DelegationId,
  PermissionKey,
  RoleId,
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

export interface SessionRepository {
  /** Refresh tokens are stored hashed; reuse of a rotated token kills the whole family. */
  findFamilyByTokenHash(tokenHash: string): Promise<{ familyId: AnyId; userId: UserId } | null>;
  revokeFamily(familyId: AnyId, reason: string): Promise<void>;
  revokeAllForUser(userId: UserId, reason: string): Promise<void>;
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
