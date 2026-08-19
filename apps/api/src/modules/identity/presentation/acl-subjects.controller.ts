import { Controller, Get, Inject, Query } from '@nestjs/common';

import { type Collection, type RoleOption, roleOptionQuerySchema } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { ROLE_ADMIN_SERVICE } from '../application/administration.ports';
import type { RoleAdminRow } from '../application/administration.ports';
import type { RoleAdminService } from '../application/role-admin.service';
import { toCollection } from './identity-admin.view';

/**
 * The subjects an ACL entry may name, as somebody writing one sees them — Slice 12.
 *
 * ## Why this route exists
 *
 * `AclSubjectType` is `USER | ROLE | DEPARTMENT`, and two of the three already had an operational
 * picker: `/directory/people` and `/directory/departments`, both behind `directory:view`, both
 * added when a metadata field needed a list and widening the administrative route was the wrong
 * fix. Roles had none, so the permissions screen fetched `/admin/roles` — `role:manage`, the tenant
 * administrator alone — and the seeded **document controller**, which holds
 * `document:permission:manage` and not `role:manage`, could not name a role in an entry it exists
 * to write.
 *
 * ## Why the guard is `document:permission:manage` and not `directory:view`
 *
 * `directory:view` is documented as *"the tenant's people and organisational units"*. A role is
 * neither — it is capability — and quietly folding roles into that key would broaden a permission
 * past what its own catalogue entry promises, in a slice whose whole point is that nothing widens.
 *
 * The operation's own key is the honest one, and it is also the tightest. Whoever may write
 * `subjectType: ROLE` on a node is precisely whoever needs to know which roles exist in order to
 * write it, and `PermissionService.validate` already accepts any identifier without checking that
 * it names anything — so reading the names of roles you may already grant to is strictly less than
 * the write you could already perform. No permission is introduced and none is widened; the set of
 * callers who can reach this is exactly the set that could already reach `PUT` on the same module.
 *
 * ## Why it lives in Identity rather than beside the permissions controller
 *
 * For the same reason `DirectoryPeopleController` does, two files away: a controller lives with the
 * data it projects, and carrying another module's permission key is a decorator rather than a
 * dependency. Library has no edge to Identity today, and a picker is not the thing to add one for.
 * The rows come from `RoleAdminService` — the same read, the same tenant scoping — and only the
 * projection differs.
 */
@Controller({ path: 'acl', version: '1' })
@RequirePermission(Permission.DOCUMENT_PERMISSION_MANAGE)
export class AclSubjectsController {
  constructor(@Inject(ROLE_ADMIN_SERVICE) private readonly roles: RoleAdminService) {}

  @Get('roles')
  async roleOptions(
    @Query(new ZodValidationPipe(roleOptionQuerySchema))
    query: ReturnType<typeof roleOptionQuerySchema.parse>,
  ): Promise<Collection<RoleOption>> {
    return toCollection(
      await this.roles.list({
        ...query,
        deleted: 'live',
        // Slice 13: `listRoles` also searches `key` and `description` by default. Neither is on
        // `RoleOption`, and an endpoint that matches a column it does not return lets a caller
        // probe for one. This searches the name it shows.
        searchFields: ['name'],
      }),
      toRoleOption,
    );
  }
}

/**
 * Named field by field rather than built by omission.
 *
 * A projection that spreads the administrative row and deletes keys grows a new field every time
 * that row does — silently, and in the direction that matters. The administrative role carries the
 * key, the description, the system flag, **every permission the role grants** and its member count;
 * that last pair is the tenant's authority map, and a picker needs a label.
 * `read-models.spec.ts` asserts each exclusion by name for the same reason.
 */
function toRoleOption(row: RoleAdminRow): RoleOption {
  return { id: row.id, name: row.name };
}
