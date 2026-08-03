import { Inject, Injectable } from '@nestjs/common';

import {
  ALL_PERMISSIONS,
  type AnyId,
  AuditSubjectType,
  type PermissionKey,
  asId,
  isPermissionKey,
  survivesBrokenInheritance,
} from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  AdministeredWriter,
  AdministrativeOperation,
  type AdministrativeOperationKey,
  checkVersion,
  requireVersion,
} from '../../../core/persistence';
import {
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { IdentityAdminAudit } from '../domain/audit-actions';
import {
  IDENTITY_ADMIN_REPOSITORY,
  type IdentityAdminRepository,
  type RoleAdminRow,
  type RoleListRequest,
} from './administration.ports';

/** One entry of the permission catalogue, as the matrix editor renders it. */
export interface PermissionDescriptorRow {
  readonly key: PermissionKey;
  readonly resource: string;
  readonly action: string;
  readonly survivesBrokenInheritance: boolean;
}

/**
 * Administering roles and the permission matrix.
 *
 * Three rules carry the weight:
 *
 * **A system role's key is fixed; everything else about it is not.** The product refers to the eight
 * seeded roles by key — the MFA policy names them, reports group by them, the seed finds them — so
 * renaming a key would break those silently. The name and the permissions are ordinary tenant data on
 * every role, seeded or not (`08-permission-model.md` §5).
 *
 * **Changing a role's permissions re-evaluates everyone holding it, now.** Every holder's
 * `permission_version` is bumped in the same transaction, so a token minted a minute ago stops being
 * accepted. A role edit that took effect at the end of everybody's token lifetime would make
 * "revoke this capability" an operation with no defined completion time.
 *
 * **A role in use cannot be deleted.** Named with the count, rather than cascading: silently removing
 * a role from forty people is not something a confirmation dialogue can honestly summarise.
 */
@Injectable()
export class RoleAdminService {
  constructor(
    @Inject(IDENTITY_ADMIN_REPOSITORY) private readonly roles: IdentityAdminRepository,
    private readonly writer: AdministeredWriter,
  ) {}

  list(request: RoleListRequest): Promise<Page<RoleAdminRow>> {
    return this.writer.read(() => this.roles.listRoles(request));
  }

  get(id: string): Promise<RoleAdminRow> {
    return this.writer.read(() => this.require(id, true));
  }

  /**
   * The catalogue, served rather than bundled into the client.
   *
   * So that the API and the UI can never disagree about which permissions exist: the matrix editor
   * renders this, and a permission absent from it is one the API would refuse anyway. Pure — it reads
   * no database and needs no transaction.
   */
  catalogue(): readonly PermissionDescriptorRow[] {
    return ALL_PERMISSIONS.map((key) => {
      // `resource:action`, and `document:history:view` splits at the *first* colon: the resource is
      // `document` and the action is `history:view`. Splitting at the last would give a resource of
      // `document:history`, and the editor would show two `document` groups.
      const separator = key.indexOf(':');
      return {
        key,
        resource: key.slice(0, separator),
        action: key.slice(separator + 1),
        survivesBrokenInheritance: survivesBrokenInheritance(key),
      };
    });
  }

  async create(input: {
    key: string;
    name: string;
    description?: string | undefined;
    permissions: readonly string[];
  }): Promise<RoleAdminRow> {
    const key = input.key.trim().toLowerCase();
    const name = this.requireName(input.name);
    const permissions = this.requirePermissions(input.permissions);

    return this.writer.write(async () => {
      if (await this.roles.roleKeyTaken(key, null)) {
        throw new DuplicateError('role', 'key');
      }

      const id = this.writer.clock.nextId();
      await this.roles.insertRole({
        id,
        key,
        name,
        description: input.description === undefined ? null : squish(input.description),
        // A tenant-defined role is never a system role. `isSystem` is the product's mark, and letting
        // a caller set it would let them create a role nobody can delete.
        isSystem: false,
        permissions,
      });

      return {
        result: await this.require(id, false),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, {
          key,
          name,
          permissions,
        }),
      };
    });
  }

  async update(
    id: string,
    patch: { name?: string; description?: string | null; permissions?: readonly string[] },
    expectedVersion: number | undefined,
  ): Promise<RoleAdminRow> {
    const permissions =
      patch.permissions === undefined ? undefined : this.requirePermissions(patch.permissions);

    return this.writer.write(async () => {
      const current = await this.require(id, false);
      // Required, not optional: a role's permission set is not recoverable from the new one, so it
      // may not be written over a state the caller has not seen.
      if (permissions !== undefined) {
        requireVersion(expectedVersion, current.version);
      } else {
        checkVersion(expectedVersion, current.version);
      }

      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      await this.roles.updateRole(id, current.version, {
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: patch.description === null ? null : squish(patch.description),
        }),
      });

      if (permissions !== undefined) {
        await this.roles.replacePermissions(id, permissions);
        // Everyone holding this role is re-evaluated on their next request. Bumped inside the same
        // transaction as the permission change, so there is no window in which the role says one
        // thing and the tokens still in flight say another.
        const holders = await this.roles.userIdsWithRole(id);
        await this.roles.bumpPermissionVersion(holders);
      }

      return {
        result: await this.require(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          {
            ...(name !== undefined && { name: current.name }),
            ...(permissions !== undefined && { permissions: current.permissions }),
          },
          {
            ...(name !== undefined && { name }),
            ...(permissions !== undefined && { permissions }),
          },
          permissions !== undefined,
        ),
      };
    });
  }

  async delete(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, false);
      requireVersion(expectedVersion, current.version);

      if (current.isSystem) {
        // The product refers to this role by key. Removing it would break the MFA policy, the seed
        // and every report that groups by it.
        throw new ValidationError('A built-in role cannot be removed.', [
          { field: 'isSystem', message: 'built in' },
        ]);
      }
      if (current.memberCount > 0) {
        throw new ValidationError('Remove this role from everyone holding it first.', [
          { field: 'memberCount', message: String(current.memberCount) },
        ]);
      }

      await this.roles.setRoleDeleted(id, current.version, true);

      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.DELETED,
          { deletedAt: null },
          {
            key: current.key,
          },
        ),
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
          change: this.changed(id, AdministrativeOperation.RESTORED, undefined, {
            alreadyLive: true,
          }),
        };
      }
      if (await this.roles.roleKeyTaken(current.key, id)) {
        throw new DuplicateError('role', 'key');
      }

      await this.roles.setRoleDeleted(id, current.version, false);

      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.RESTORED,
          { deletedAt: current.deletedAt },
          {
            key: current.key,
          },
        ),
      };
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private async require(id: string, includeDeleted: boolean): Promise<RoleAdminRow> {
    const row = await this.roles.findRole(id, includeDeleted);
    if (!row) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  /**
   * Narrows an untrusted list to the catalogue.
   *
   * The wire schema already restricts it to `ALL_PERMISSIONS`, and this is the second check the
   * validation pipeline is built around: the DTO protects the parser, and this protects the invariant
   * regardless of who constructed the call — a controller, a seed, a future queue consumer.
   */
  private requirePermissions(raw: readonly string[]): readonly PermissionKey[] {
    const unknown = raw.filter((permission) => !isPermissionKey(permission));
    if (unknown.length > 0) {
      throw new ValidationError('That permission does not exist.', [
        { field: 'permissions', message: unknown.join(', ') },
      ]);
    }
    // Deduplicated: `role_permission` is keyed on `(roleId, permission)`, so a repeated entry would
    // be a constraint violation rather than a no-op.
    return [...new Set(raw.filter(isPermissionKey))];
  }

  private requireName(raw: string): string {
    const name = squish(raw);
    if (name.length === 0) {
      throw new ValidationError('A name is required.', [{ field: 'name', message: 'required' }]);
    }
    return name;
  }

  private changed(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
    permissionsChanged = false,
  ) {
    return {
      // The catalogue names `ROLE_PERMISSION_CHANGED` for a change to what a role may do, which is
      // the event an investigation looks for; other edits to a role are an assignment-group event.
      action: permissionsChanged
        ? IdentityAdminAudit.ROLE_PERMISSION_CHANGED
        : IdentityAdminAudit.ROLE_ASSIGNED,
      subjectType: AuditSubjectType.ROLE,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before }),
      ...(after && { after }),
    };
  }
}
