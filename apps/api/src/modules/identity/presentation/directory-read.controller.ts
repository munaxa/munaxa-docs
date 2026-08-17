import { Controller, Get, Inject, Query } from '@nestjs/common';

import { type Collection, type PersonOption, personOptionQuerySchema } from '@edms/contracts';
import { Permission, UserStatus } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { USER_ADMIN_SERVICE } from '../application/administration.ports';
import type { UserAdminRow } from '../application/administration.ports';
import type { UserAdminService } from '../application/user-admin.service';
import { toCollection } from './identity-admin.view';

/**
 * People, as somebody choosing one sees them.
 *
 * ## Why this is not `/admin/users` with a softer guard
 *
 * A document type may define a metadata field of type `USER`, and filling one in needs a list of
 * people to choose from. The only list in the product was `/admin/users`, behind `user:manage` —
 * held by the tenant administrator alone — so a document controller could not fill in a field the
 * tenant had configured for it, and the workspace that offered the field failed outright.
 *
 * Widening that endpoint was the obvious fix and would have been the wrong one. `User` carries the
 * address, the account status, MFA enrolment, last sign-in, whether a password is set, every role
 * held and every department joined. Handing that to a filing clerk because a dropdown needed
 * labels would have made every holder of the new key an auditor of the tenant's staff: who has not
 * enrolled, who has never signed in, who holds which authority.
 *
 * So `/admin/users` is untouched and keeps `user:manage`, and this returns an identifier and a
 * name. The rows come from `UserAdminService` — the same read, the same tenant scoping — and only
 * the projection differs.
 *
 * **Active accounts only, and not as a filter the caller may turn off.** A picker offering a
 * disabled account offers an assignment that resolves to nobody. Managing an account and choosing
 * a person are different questions, and the administration screens keep their status filter for
 * the first one.
 */
@Controller({ path: 'directory', version: '1' })
@RequirePermission(Permission.DIRECTORY_VIEW)
export class DirectoryPeopleController {
  constructor(@Inject(USER_ADMIN_SERVICE) private readonly users: UserAdminService) {}

  @Get('people')
  async people(
    @Query(new ZodValidationPipe(personOptionQuerySchema))
    query: ReturnType<typeof personOptionQuerySchema.parse>,
  ): Promise<Collection<PersonOption>> {
    return toCollection(
      await this.users.list({
        ...query,
        deleted: 'live',
        status: UserStatus.ACTIVE,
      }),
      toPersonOption,
    );
  }
}

/**
 * Named field by field rather than built by omission.
 *
 * A projection that spreads the administrative row and deletes keys grows a new field every time
 * that row does, silently and in the direction that matters. `read-models.spec.ts` asserts each
 * exclusion by name for the same reason.
 */
function toPersonOption(row: UserAdminRow): PersonOption {
  return { id: row.id, displayName: row.displayName };
}
