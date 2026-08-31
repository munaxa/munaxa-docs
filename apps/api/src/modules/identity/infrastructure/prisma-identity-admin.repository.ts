import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { type PermissionKey, isPermissionKey } from '@edms/domain';
import { type Page, toPage } from '@edms/utils';

import { DuplicateError, VersionConflictError } from '../../../core/errors/application-errors';
import {
  RecordStamps,
  deletedCondition,
  orderByFor,
  pageArgs,
  searchConditions,
} from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';
import { permissionVersionKey } from './cached-permission-version.reader';
import type {
  DepartmentMembership,
  IdentityAdminRepository,
  RoleAdminRow,
  RoleListRequest,
  UserAdminRow,
  UserListRequest,
} from '../application/administration.ports';

/**
 * Users, roles and the permission matrix, in the database.
 *
 * Two details are worth calling out.
 *
 * **`hasPassword` is a boolean, computed here.** The column is selected only to ask whether it is
 * null, and the hash never enters a row this layer returns. The narrower the audience for a
 * credential, the fewer places it can be logged from.
 *
 * **Role and department sets are replaced, not diffed.** `deleteMany` then `createMany`, in one
 * transaction. A diff would be a second place that decides which membership is primary, and the
 * partial unique index on `is_primary` would then be enforcing a rule two pieces of code disagree
 * about.
 */
@Injectable()
export class PrismaIdentityAdminRepository implements IdentityAdminRepository {
  constructor(
    private readonly stamps: RecordStamps,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
  ) {}

  // --- Users -----------------------------------------------------------------------------

  async listUsers(request: UserListRequest): Promise<Page<UserAdminRow>> {
    const tx = requireTransaction();
    const where: Prisma.UserWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.status !== undefined && { status: request.status }),
      ...(request.roleId !== undefined && { roles: { some: { roleId: request.roleId } } }),
      ...(request.departmentId !== undefined && {
        departments: { some: { departmentId: request.departmentId } },
      }),
      OR: searchConditions(request.search, request.searchFields ?? ['displayName', 'email']),
    };

    const [rows, total] = await Promise.all([
      tx.user.findMany({
        where,
        orderBy: orderByFor(
          request.sortBy as 'displayName' | 'email' | undefined,
          request.sortDirection,
          'displayName',
        ),
        ...pageArgs(request),
        select: USER_SELECTION,
      }),
      tx.user.count({ where }),
    ]);

    return toPage(rows.map(toUserRow), total, request);
  }

  async findUser(id: string, includeDeleted: boolean): Promise<UserAdminRow | null> {
    const row = await requireTransaction().user.findFirst({
      where: { id, tenantId: this.tenantId(), ...(includeDeleted ? {} : { deletedAt: null }) },
      select: USER_SELECTION,
    });
    return row ? toUserRow(row) : null;
  }

  async emailTaken(emailNormalized: string, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().user.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        // Already normalised by the caller; compared insensitively anyway, because the partial
        // unique index is on the stored value and a stray capital would slip past a strict compare.
        emailNormalized: { equals: emailNormalized, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertUser(input: {
    id: string;
    email: string;
    emailNormalized: string;
    displayName: string;
  }): Promise<void> {
    /*
     * `emailTaken` and this insert are the same question asked at two moments — Slice 63.
     *
     * `uq_user_tenant_email` is partial on `deleted_at IS NULL`, which is exactly the condition the
     * check reads, so two administrators inviting one address both saw it free and both arrive
     * here. The index admits one, and the loser used to meet a raw `P2002` — neither a
     * `DomainError` nor an `HttpException`, so `AllExceptionsFilter` answered `500` on an invite
     * form, where the same request a moment later in sequence is refused with "already in use".
     *
     * Caught rather than tolerated, and the difference from Slice 61's federated identity is the
     * whole reason: there the loser had to *read* the account that won, and a unique violation
     * aborts the transaction so no read could follow it. Here the loser needs no read — only a
     * different exception — so translating at the boundary that knows what the index means is both
     * sufficient and the pattern this repository already uses for `uq_document_signature_live`.
     */
    await this.claimingTheAddress(() =>
      requireTransaction().user.create({
        data: {
          ...input,
          tenantId: this.tenantId(),
          // A new account cannot sign in until somebody sets a password, which is what INVITED means.
          status: 'INVITED',
          ...this.stamps.creation(),
        },
      }),
    );
  }

  async updateUser(
    id: string,
    version: number,
    patch: {
      email?: string;
      emailNormalized?: string;
      displayName?: string;
      status?: UserAdminRow['status'];
    },
  ): Promise<void> {
    // The address is one of the things this patch can move, so this write can meet the index that
    // `emailTaken` read a moment ago — Slice 64.
    const { count } = await this.claimingTheAddress(() =>
      requireTransaction().user.updateMany({
        where: { id, tenantId: this.tenantId(), version, deletedAt: null },
        data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
      }),
    );
    this.requireOneRow(count, version);
  }

  async setUserDeleted(id: string, version: number, deleted: boolean): Promise<void> {
    /*
     * Restoring re-enters the index — Slice 64.
     *
     * `uq_user_tenant_email` is partial on `deleted_at IS NULL`, so a deleted row sits outside it
     * and clearing the stamp puts the address back under it. The service asks `emailTaken` first
     * and says why — "the address was released when the account was deleted, and may have been
     * re-invited since" — but that read and this write are two statements, and an invitation can
     * land between them.
     */
    const { count } = await this.claimingTheAddress(() =>
      requireTransaction().user.updateMany({
        where: { id, tenantId: this.tenantId(), version },
        data: {
          ...(deleted ? this.stamps.deletion() : this.stamps.restoration()),
          version: { increment: 1 },
        },
      }),
    );
    this.requireOneRow(count, version);
  }

  async replaceRoles(userId: string, roleIds: readonly string[]): Promise<void> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    await tx.userRole.deleteMany({ where: { tenantId, userId } });
    if (roleIds.length === 0) {
      return;
    }
    await tx.userRole.createMany({
      data: roleIds.map((roleId) => ({
        tenantId,
        userId,
        roleId,
        assignedAt: this.stamps.now(),
        assignedBy: requireContext().userId,
      })),
    });
  }

  async replaceDepartments(
    userId: string,
    memberships: readonly DepartmentMembership[],
  ): Promise<void> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    await tx.userDepartment.deleteMany({ where: { tenantId, userId } });
    if (memberships.length === 0) {
      return;
    }
    await tx.userDepartment.createMany({
      data: memberships.map((membership) => ({
        tenantId,
        userId,
        departmentId: membership.departmentId,
        isPrimary: membership.isPrimary,
        isManager: membership.isManager,
        assignedAt: this.stamps.now(),
        assignedBy: requireContext().userId,
      })),
    });
  }

  async liveDepartmentIds(ids: readonly string[]): Promise<readonly string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await requireTransaction().department.findMany({
      where: { tenantId: this.tenantId(), id: { in: [...ids] }, deletedAt: null },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async bumpPermissionVersion(userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    const tenantId = this.tenantId();
    // Not version-guarded, and deliberately: this is not an edit somebody could lose a race over, it
    // is a counter whose only job is to differ from what the outstanding tokens carry. Guarding it
    // would make a role change fail because one of forty holders was edited concurrently.
    await requireTransaction().user.updateMany({
      where: { tenantId, id: { in: [...userIds] } },
      data: { permissionVersion: { increment: 1 } },
    });

    /*
     * The cached generation goes with it — Slice 31, and here rather than in the three services
     * that call this so that no future caller can raise the number without clearing the answer.
     * That is the same reasoning `LIVE_ROLES` was placed in the credential repository for: the one
     * place every path passes through is where an invariant is worth enforcing.
     *
     * **Inside the transaction, before it commits**, which is the ordering `AclPermissionService.
     * afterChange` established — "invalidating first means the window in which a stale decision
     * could be read closes before anything downstream reacts". Redis cannot enlist in a PostgreSQL
     * transaction, so what that ordering buys is a choice of which way the two can disagree:
     *
     *   - delete succeeds, transaction rolls back → the entry is merely cold and the next read
     *     repopulates it from the database with the unchanged number. Nothing is wrong.
     *   - delete fails → it throws here, the transaction rolls back, and the permission change is
     *     refused. The administrator sees an error and retries.
     *
     * The combination this ordering makes unreachable is the dangerous one: a committed bump whose
     * cache entry still holds the old number, which would leave every outstanding token valid
     * until the TTL expired. It is not atomic, and it is not claimed to be — it is arranged so
     * that the only surviving disagreement is the safe one.
     */
    await Promise.all(
      userIds.map((userId) => this.cache.delete(permissionVersionKey(tenantId, userId))),
    );
  }

  async userIdsWithRole(roleId: string): Promise<readonly string[]> {
    const rows = await requireTransaction().userRole.findMany({
      where: { tenantId: this.tenantId(), roleId },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  async setPasswordHash(id: string, encodedHash: string, at: Date): Promise<void> {
    await requireTransaction().user.updateMany({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      data: {
        passwordHash: encodedHash,
        passwordAlgorithm: 'SCRYPT',
        passwordUpdatedAt: at,
        ...this.stamps.update(),
      },
    });
  }

  async revokeSessions(userId: string, reason: string): Promise<void> {
    // Every family the user holds, in one statement. The families are the unit of revocation, and
    // their refresh tokens cascade from them.
    await requireTransaction().sessionFamily.updateMany({
      where: { tenantId: this.tenantId(), userId, revokedAt: null },
      data: { revokedAt: this.stamps.now(), revokedReason: reason },
    });
  }

  // --- Roles -----------------------------------------------------------------------------

  async listRoles(request: RoleListRequest): Promise<Page<RoleAdminRow>> {
    const tx = requireTransaction();
    const where: Prisma.RoleWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      // "Which roles can approve" is a question administrators ask, which is why the matrix is a
      // table of rows rather than an array column.
      ...(request.permission !== undefined && {
        permissions: { some: { permission: request.permission } },
      }),
      OR: searchConditions(request.search, request.searchFields ?? ['name', 'key', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.role.findMany({
        where,
        orderBy: orderByFor(
          request.sortBy as 'name' | 'key' | undefined,
          request.sortDirection,
          'name',
        ),
        ...pageArgs(request),
        select: ROLE_SELECTION,
      }),
      tx.role.count({ where }),
    ]);

    return toPage(rows.map(toRoleRow), total, request);
  }

  async findRole(id: string, includeDeleted: boolean): Promise<RoleAdminRow | null> {
    const row = await requireTransaction().role.findFirst({
      where: { id, tenantId: this.tenantId(), ...(includeDeleted ? {} : { deletedAt: null }) },
      select: ROLE_SELECTION,
    });
    return row ? toRoleRow(row) : null;
  }

  async roleKeyTaken(key: string, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().role.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        key: { equals: key, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertRole(input: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    permissions: readonly PermissionKey[];
  }): Promise<void> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    // `roleKeyTaken` and this insert are the same question at two moments — Slice 65.
    await this.claimingTheKey(() =>
      tx.role.create({
        data: {
          id: input.id,
          tenantId,
          key: input.key,
          name: input.name,
          description: input.description,
          isSystem: input.isSystem,
          ...this.stamps.creation(),
        },
      }),
    );
    if (input.permissions.length > 0) {
      await tx.rolePermission.createMany({
        data: input.permissions.map((permission) => ({ tenantId, roleId: input.id, permission })),
      });
    }
  }

  async updateRole(
    id: string,
    version: number,
    patch: { name?: string; description?: string | null },
  ): Promise<void> {
    const { count } = await requireTransaction().role.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  async replacePermissions(roleId: string, permissions: readonly PermissionKey[]): Promise<void> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    await tx.rolePermission.deleteMany({ where: { tenantId, roleId } });
    if (permissions.length === 0) {
      return;
    }
    await tx.rolePermission.createMany({
      data: permissions.map((permission) => ({ tenantId, roleId, permission })),
    });
  }

  async setRoleDeleted(id: string, version: number, deleted: boolean): Promise<void> {
    /*
     * Restoring re-enters the index — Slice 65, and the same shape `setUserDeleted` has.
     *
     * `uq_role_tenant_key` is partial on `deleted_at IS NULL`, so a deleted role sits outside it and
     * clearing the stamp puts its key back under it. Slice 22 is what makes that reachable rather
     * than theoretical: a tenant may delete `contractors` and create a new `contractors`, so a role
     * in the recycle bin whose key has been taken since is the expected state.
     */
    const { count } = await this.claimingTheKey(() =>
      requireTransaction().role.updateMany({
        where: { id, tenantId: this.tenantId(), version },
        data: {
          ...(deleted ? this.stamps.deletion() : this.stamps.restoration()),
          version: { increment: 1 },
        },
      }),
    );
    this.requireOneRow(count, version);
  }

  async liveRoleIds(ids: readonly string[]): Promise<readonly string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await requireTransaction().role.findMany({
      where: { tenantId: this.tenantId(), id: { in: [...ids] }, deletedAt: null },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  // --- Internals -------------------------------------------------------------------------

  private tenantId(): string {
    return requireContext().tenantId;
  }

  /**
   * Runs a write that can meet a partial unique index, and translates that one violation.
   *
   * Five statements here reach one: inviting an address, changing one, restoring an account whose
   * address re-enters the index, creating a role key, and restoring a role whose key re-enters it.
   * Each asks a `…Taken` question first, and each asks it a moment before it writes — so each can
   * lose the claim in between and must answer the way the administrator who arrived second in order
   * is answered.
   *
   * Translating rather than tolerating, for the reason Slice 63 set out: a unique violation aborts
   * the transaction, so a loser that needed to *read* could not recover here. None of these do.
   * They need a different exception, and the boundary that knows what the index means is where it
   * belongs.
   */
  private async claimingUnique<TResult>(
    model: 'User' | 'Role',
    duplicate: () => DuplicateError,
    write: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolationOn(error, model)) {
        throw duplicate();
      }
      throw error;
    }
  }

  /** The address claim: one live account per address in a tenant. */
  private claimingTheAddress<TResult>(write: () => Promise<TResult>): Promise<TResult> {
    return this.claimingUnique('User', () => new DuplicateError('user', 'email'), write);
  }

  /** The key claim: one live role per key in a tenant. */
  private claimingTheKey<TResult>(write: () => Promise<TResult>): Promise<TResult> {
    return this.claimingUnique('Role', () => new DuplicateError('role', 'key'), write);
  }

  private requireOneRow(count: number, expectedVersion: number): void {
    if (count === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }
  }
}

/**
 * What a user row carries to the administration layer.
 *
 * A `select` rather than an `include`, so `passwordHash` is named nowhere and cannot arrive by
 * accident when somebody adds a column.
 */
const USER_SELECTION = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  mfaEnrolled: true,
  lastLoginAt: true,
  // Selected to ask whether it is null, and mapped to a boolean immediately below. The value never
  // leaves this file.
  passwordHash: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  deletedAt: true,
  deletedBy: true,
  version: true,
  roles: { select: { role: { select: { id: true, key: true, name: true } } } },
  departments: {
    select: {
      departmentId: true,
      isPrimary: true,
      isManager: true,
      department: { select: { name: true, code: true } },
    },
  },
} as const;

const ROLE_SELECTION = {
  id: true,
  key: true,
  name: true,
  description: true,
  isSystem: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  deletedAt: true,
  deletedBy: true,
  version: true,
  permissions: { select: { permission: true } },
  _count: { select: { users: true } },
} as const;

interface UserSelection {
  id: string;
  email: string;
  displayName: string;
  status: UserAdminRow['status'];
  mfaEnrolled: boolean;
  lastLoginAt: Date | null;
  passwordHash: string | null;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  version: number;
  roles: { role: { id: string; key: string; name: string } }[];
  departments: {
    departmentId: string;
    isPrimary: boolean;
    isManager: boolean;
    department: { name: string; code: string };
  }[];
}

function toUserRow(row: UserSelection): UserAdminRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    mfaEnrolled: row.mfaEnrolled,
    lastLoginAt: row.lastLoginAt,
    hasPassword: row.passwordHash !== null,
    roles: row.roles.map((held) => held.role),
    departments: row.departments.map((membership) => ({
      departmentId: membership.departmentId,
      name: membership.department.name,
      code: membership.department.code,
      isPrimary: membership.isPrimary,
      isManager: membership.isManager,
    })),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
  };
}

interface RoleSelection {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  version: number;
  permissions: { permission: string }[];
  _count: { users: number };
}

function toRoleRow(row: RoleSelection): RoleAdminRow {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    // Narrowed on the way out, not just on the way in. `role_permission.permission` is `text`
    // deliberately — adding a permission must not need a migration in lockstep with the code — so a
    // row written by an older release, or by hand, can name something the catalogue no longer has.
    // Dropping it here is what stops that reaching a guard as an unrecognised grant.
    permissions: row.permissions.map((held) => held.permission).filter(isPermissionKey),
    memberCount: row._count.users,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
  };
}

/**
 * The one violation a claiming write translates; anything else is a genuine failure.
 *
 * Matched by model rather than by index name, and that limit is worth stating rather than hiding:
 * `uq_user_tenant_email` and `uq_role_tenant_key` are both **partial**, and Prisma reports
 * `target: null` for a partial index — measured, `{"modelName":"User","target":null}` — so there is
 * no name to compare. Naming one, as `uq_document_signature_live` is named, would produce a check
 * that never fires.
 *
 * What makes the unnamed match exact is the statement doing the writing. Each caller below can
 * reach exactly one unique index on its table:
 *
 * - `user` carries three. `uq_user_external_identity` covers `(tenant_id, identity_provider_id,
 *   external_id)`, and the invite writes neither provider nor subject, so both are `NULL` and
 *   PostgreSQL holds `NULL`s distinct; the update and the restore touch neither. `user_pkey` is a
 *   freshly minted UUIDv7 on insert and untouched on update.
 * - `role` carries two. `role_pkey` is likewise a fresh UUIDv7, and the permission rows that follow
 *   an insert belong to `RolePermission`, which this predicate does not match.
 *
 * The address and the key are the only values here another live row can already hold.
 */
function isUniqueViolationOn(error: unknown, model: 'User' | 'Role'): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    error.meta?.['modelName'] === model
  );
}
