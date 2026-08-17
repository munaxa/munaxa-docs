import { Controller, Get, Inject, Query } from '@nestjs/common';

import {
  type Collection,
  type DepartmentOption,
  departmentOptionQuerySchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { SCOPE_ADMIN_SERVICE } from '../application/ports';
import type { DepartmentRow } from '../application/ports';
import type { ScopeAdminService } from '../application/scope-admin.service';
import { toCollection } from './organization.view';

/**
 * Departments, as somebody choosing one sees them.
 *
 * This is the endpoint `OrganizationController` said would arrive: *"Later phases that need a
 * department picker for non-admins add a narrower endpoint rather than widening this one."* The
 * phase is this one, and the reason is a `DEPARTMENT` metadata field that a document controller
 * could not fill in because the only department list in the product was behind `org:manage`.
 *
 * The argument for not widening the administrative route is that controller's own: an organisation
 * chart names every legal entity and every unit a customer has, and `Department` adds the headcount
 * of each. A picker needs a name and enough ancestry to tell two units called `Quality` apart, so
 * that is what this returns. `/admin/departments` is untouched and keeps `org:manage`.
 *
 * No `@ScopedTo`: a department is not a node in the document scope tree these routes could ask
 * about, and `RbacGuard`'s tenant-wide answer is the whole answer — as it is for the sibling
 * people endpoint.
 */
@Controller({ path: 'directory', version: '1' })
@RequirePermission(Permission.DIRECTORY_VIEW)
export class DirectoryDepartmentsController {
  constructor(@Inject(SCOPE_ADMIN_SERVICE) private readonly scopes: ScopeAdminService) {}

  @Get('departments')
  async departments(
    @Query(new ZodValidationPipe(departmentOptionQuerySchema))
    query: ReturnType<typeof departmentOptionQuerySchema.parse>,
  ): Promise<Collection<DepartmentOption>> {
    return toCollection(
      await this.scopes.listDepartments({ ...query, deleted: 'live' }),
      toDepartmentOption,
    );
  }
}

/** Named field by field, so a new column on the administrative row cannot join this one silently. */
function toDepartmentOption(row: DepartmentRow): DepartmentOption {
  return { id: row.id, code: row.code, name: row.name, path: row.path };
}
