import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, AuditSubjectType, UserStatus, type UserStatusKey, asId } from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  AdministeredWriter,
  AdministrativeOperation,
  checkVersion,
  requireVersion,
} from '../../../core/persistence';
import {
  DuplicateError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { IdentityAdminAudit, SecurityAudit } from '../domain/audit-actions';
import { checkPassword } from '../domain/password-policy';
import { isPlausibleEmail, normalizeEmail } from '../domain/user';
import {
  type DepartmentMembership,
  IDENTITY_ADMIN_REPOSITORY,
  type IdentityAdminRepository,
  type UserAdminRow,
  type UserListRequest,
} from './administration.ports';
import { PASSWORD_HASHER, type PasswordHasher } from './authentication.ports';

/**
 * Administering the people who can sign in.
 *
 * Ordinary CRUD in shape, and four rules in it are not:
 *
 * **A permission change takes effect on the next request, not the next sign-in.** Changing somebody's
 * roles bumps their `permission_version`, and an access token carrying an older value is refused. The
 * alternative is a revoked role that keeps working for the rest of a fifteen-minute token
 * (`08-permission-model.md` §7).
 *
 * **Setting a password ends every session.** Whoever knew the old password may not be whoever should
 * keep the session, and the administrator setting a new one is usually doing it *because* of that
 * (`17-security-architecture.md` §2).
 *
 * **You cannot disable or delete yourself.** Not paternalism: a tenant whose last administrator
 * locks themselves out needs a database console to recover, and the mistake is one keystroke away
 * from the button that disables somebody else.
 *
 * **Deleting frees the email address.** The unique index is partial on `deleted_at IS NULL`, so a
 * person who leaves and returns is re-invited rather than resurrected — and restoring the old account
 * is refused if the address has been taken since.
 *
 * There is no invitation email here. The notification framework exists and could send one, but an
 * invitation is a *credential-bearing* token with its own expiry, single use and revocation, and that
 * belongs with the rest of the credential lifecycle in the security phase. Until then an
 * administrator sets the first password and tells the person, which is honest about what is happening
 * rather than implying a flow that is not there.
 */
@Injectable()
export class UserAdminService {
  constructor(
    @Inject(IDENTITY_ADMIN_REPOSITORY) private readonly people: IdentityAdminRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    private readonly writer: AdministeredWriter,
  ) {}

  list(request: UserListRequest): Promise<Page<UserAdminRow>> {
    return this.writer.read(() => this.people.listUsers(request));
  }

  get(id: string): Promise<UserAdminRow> {
    return this.writer.read(() => this.require(id, true));
  }

  async create(input: {
    email: string;
    displayName: string;
    roleIds: readonly string[];
    departments: readonly DepartmentMembership[];
  }): Promise<UserAdminRow> {
    const email = input.email.trim();
    const emailNormalized = normalizeEmail(email);
    if (!isPlausibleEmail(emailNormalized)) {
      throw new ValidationError('That does not look like an email address.', [
        { field: 'email', message: 'implausible' },
      ]);
    }
    const displayName = this.requireName(input.displayName);
    this.refuseDuplicatePrimary(input.departments);

    return this.writer.write(async () => {
      if (await this.people.emailTaken(emailNormalized, null)) {
        throw new DuplicateError('user', 'email');
      }
      await this.requireLiveRoles(input.roleIds);
      await this.requireLiveDepartments(input.departments);

      const id = this.writer.clock.nextId();
      await this.people.insertUser({ id, email, emailNormalized, displayName });
      await this.people.replaceRoles(id, input.roleIds);
      await this.people.replaceDepartments(id, input.departments);

      return {
        result: await this.require(id, false),
        change: {
          action: IdentityAdminAudit.USER_CREATED,
          subjectType: AuditSubjectType.USER,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.CREATED,
          // The address and the grants, never a credential: the trail says an account was created
          // and what it can do, and never what its password was.
          after: { email, displayName, roleIds: input.roleIds, status: UserStatus.INVITED },
        },
      };
    });
  }

  async update(
    id: string,
    patch: {
      email?: string;
      displayName?: string;
      roleIds?: readonly string[];
      departments?: readonly DepartmentMembership[];
    },
    expectedVersion: number | undefined,
  ): Promise<UserAdminRow> {
    if (patch.departments !== undefined) {
      this.refuseDuplicatePrimary(patch.departments);
    }

    return this.writer.write(async () => {
      const current = await this.require(id, false);
      checkVersion(expectedVersion, current.version);

      const email = patch.email === undefined ? undefined : patch.email.trim();
      const emailNormalized = email === undefined ? undefined : normalizeEmail(email);
      if (emailNormalized !== undefined) {
        if (!isPlausibleEmail(emailNormalized)) {
          throw new ValidationError('That does not look like an email address.', [
            { field: 'email', message: 'implausible' },
          ]);
        }
        if (
          emailNormalized !== normalizeEmail(current.email) &&
          (await this.people.emailTaken(emailNormalized, id))
        ) {
          throw new DuplicateError('user', 'email');
        }
      }
      const displayName =
        patch.displayName === undefined ? undefined : this.requireName(patch.displayName);

      if (patch.roleIds !== undefined) {
        await this.requireLiveRoles(patch.roleIds);
      }
      if (patch.departments !== undefined) {
        await this.requireLiveDepartments(patch.departments);
      }

      await this.people.updateUser(id, current.version, {
        ...(email !== undefined && { email }),
        ...(emailNormalized !== undefined && { emailNormalized }),
        ...(displayName !== undefined && { displayName }),
      });

      if (patch.roleIds !== undefined) {
        await this.people.replaceRoles(id, patch.roleIds);
        // What they may do changed, so their token must stop being accepted. One bump, whether they
        // gained a role or lost one — a revoked role is the case that matters.
        await this.people.bumpPermissionVersion([id]);
      }
      if (patch.departments !== undefined) {
        await this.people.replaceDepartments(id, patch.departments);
        // Department membership is a *subject* the ACL resolver matches on, so changing it changes
        // reach even when no role changed.
        await this.people.bumpPermissionVersion([id]);
      }

      return {
        result: await this.require(id, false),
        change: {
          action: IdentityAdminAudit.USER_CHANGED,
          subjectType: AuditSubjectType.USER,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          before: {
            ...(email !== undefined && { email: current.email }),
            ...(displayName !== undefined && { displayName: current.displayName }),
            ...(patch.roleIds !== undefined && { roleIds: current.roles.map((role) => role.id) }),
          },
          after: {
            ...(email !== undefined && { email }),
            ...(displayName !== undefined && { displayName }),
            ...(patch.roleIds !== undefined && { roleIds: patch.roleIds }),
          },
        },
      };
    });
  }

  /**
   * Sets somebody's password, applying the tenant's policy.
   *
   * The policy applies here and not at sign-in, and the asymmetry is deliberate: this is a password
   * being *set*, whereas rejecting a weak password at sign-in would lock out a legitimate holder of
   * an older one and tell an attacker which candidates are worth trying.
   */
  async setPassword(
    id: string,
    password: string,
    expectedVersion: number | undefined,
  ): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, false);
      checkVersion(expectedVersion, current.version);

      const rejections = checkPassword(password, [current.email, current.displayName]);
      if (rejections.length > 0) {
        throw new ValidationError(
          'That password is not acceptable.',
          rejections.map((reason) => ({ field: 'password', message: reason })),
        );
      }

      const encoded = await this.passwords.hash(password);
      await this.people.setPasswordHash(id, encoded, this.writer.clock.now());
      // Every session ends. The person whose password this was may not be the person who should keep
      // the session open, and that is usually why an administrator is here.
      await this.people.revokeSessions(id, 'PASSWORD_SET_BY_ADMINISTRATOR');

      // An invited user who now has a password can sign in, which is what ACTIVE means.
      if (current.status === UserStatus.INVITED) {
        await this.people.updateUser(id, current.version, { status: UserStatus.ACTIVE });
      }

      return {
        result: undefined,
        change: {
          action: SecurityAudit.PASSWORD_CHANGED,
          subjectType: AuditSubjectType.USER,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          // That it happened, by whom, and that sessions ended. Never the password, never the hash.
          after: { setByAdministrator: true, sessionsRevoked: true },
        },
      };
    });
  }

  /** Enables or disables an account. A disabled user holds no active session. */
  async setStatus(
    id: string,
    status: Extract<UserStatusKey, 'ACTIVE' | 'DISABLED'>,
    expectedVersion: number | undefined,
  ): Promise<UserAdminRow> {
    return this.writer.write(async () => {
      const current = await this.require(id, false);
      checkVersion(expectedVersion, current.version);
      if (status === UserStatus.DISABLED) {
        this.refuseSelf(id, 'disable your own account');
      }
      if (status === UserStatus.ACTIVE && !current.hasPassword) {
        // Activating somebody with no password would produce an account that is ACTIVE and cannot
        // sign in, which reads to an administrator as the product being broken.
        throw new ValidationError('Set a password before activating this account.', [
          { field: 'status', message: 'no password' },
        ]);
      }

      await this.people.updateUser(id, current.version, { status });
      if (status === UserStatus.DISABLED) {
        await this.people.revokeSessions(id, 'ACCOUNT_DISABLED');
      }

      return {
        result: await this.require(id, false),
        change: {
          action:
            status === UserStatus.DISABLED
              ? IdentityAdminAudit.USER_DISABLED
              : IdentityAdminAudit.USER_CHANGED,
          subjectType: AuditSubjectType.USER,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.UPDATED,
          before: { status: current.status },
          after: { status },
        },
      };
    });
  }

  async delete(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, false);
      requireVersion(expectedVersion, current.version);
      this.refuseSelf(id, 'delete your own account');

      await this.people.setUserDeleted(id, current.version, true);
      // A deleted account must not keep a live session; the row is gone from every list, and the
      // token would still verify.
      await this.people.revokeSessions(id, 'ACCOUNT_DELETED');

      return {
        result: undefined,
        change: {
          action: IdentityAdminAudit.USER_DISABLED,
          subjectType: AuditSubjectType.USER,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.DELETED,
          after: { email: current.email, sessionsRevoked: true },
        },
      };
    });
  }

  async restore(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, true);
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt === null) {
        return {
          result: undefined,
          change: {
            action: IdentityAdminAudit.USER_CHANGED,
            subjectType: AuditSubjectType.USER,
            subjectId: asId<AnyId>(id),
            operation: AdministrativeOperation.RESTORED,
            after: { alreadyLive: true },
          },
        };
      }

      // The address was released when the account was deleted, and may have been re-invited since.
      if (await this.people.emailTaken(normalizeEmail(current.email), id)) {
        throw new DuplicateError('user', 'email');
      }

      await this.people.setUserDeleted(id, current.version, false);

      return {
        result: undefined,
        change: {
          action: IdentityAdminAudit.USER_CHANGED,
          subjectType: AuditSubjectType.USER,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.RESTORED,
          after: { email: current.email },
        },
      };
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private async require(id: string, includeDeleted: boolean): Promise<UserAdminRow> {
    const row = await this.people.findUser(id, includeDeleted);
    if (!row) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  /**
   * `ForbiddenError`, not `NotFoundError`.
   *
   * The caller plainly may know this object exists — it is their own account — so hiding it would be
   * theatre. `NotFoundError` is for objects a caller may not know about.
   */
  private refuseSelf(id: string, action: string): void {
    if (requireContext().userId === id) {
      throw new ForbiddenError(action);
    }
  }

  private refuseDuplicatePrimary(memberships: readonly DepartmentMembership[]): void {
    const primaries = memberships.filter((membership) => membership.isPrimary);
    if (primaries.length > 1) {
      // The database enforces this too, with a partial unique index. Checking here is what turns a
      // constraint violation into a message that says which field is wrong.
      throw new ValidationError('Only one department can be the primary one.', [
        { field: 'departments', message: 'more than one primary' },
      ]);
    }
    const ids = memberships.map((membership) => membership.departmentId);
    if (new Set(ids).size !== ids.length) {
      throw new ValidationError('A department is listed twice.', [
        { field: 'departments', message: 'duplicate' },
      ]);
    }
  }

  private async requireLiveRoles(roleIds: readonly string[]): Promise<void> {
    if (roleIds.length === 0) {
      return;
    }
    const live = new Set(await this.people.liveRoleIds(roleIds));
    const missing = roleIds.filter((roleId) => !live.has(roleId));
    if (missing.length > 0) {
      // Named rather than silently dropped: a form that appeared to grant a role it did not is worse
      // than one that refuses.
      throw new ValidationError('One of those roles does not exist.', [
        { field: 'roleIds', message: missing.join(', ') },
      ]);
    }
  }

  private async requireLiveDepartments(
    memberships: readonly DepartmentMembership[],
  ): Promise<void> {
    if (memberships.length === 0) {
      return;
    }
    const ids = memberships.map((membership) => membership.departmentId);
    const live = new Set(await this.people.liveDepartmentIds(ids));
    const missing = ids.filter((id) => !live.has(id));
    if (missing.length > 0) {
      throw new ValidationError('One of those departments does not exist.', [
        { field: 'departments', message: missing.join(', ') },
      ]);
    }
  }

  private requireName(raw: string): string {
    const name = squish(raw);
    if (name.length === 0) {
      throw new ValidationError('A name is required.', [
        { field: 'displayName', message: 'required' },
      ]);
    }
    return name;
  }
}
