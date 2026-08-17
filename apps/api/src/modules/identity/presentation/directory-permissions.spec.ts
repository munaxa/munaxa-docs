import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { Permission, type PermissionKey } from '@edms/domain';

import { REQUIRED_PERMISSIONS } from '../../../core/authorization/permission.decorator';
import { DirectoryPeopleController } from './directory-read.controller';
import { RoleAdminController, UserAdminController } from './identity-admin.controller';

/**
 * Choosing a person, and administering one — two routes, two keys, and the second is unmoved.
 *
 * ## Why the assertions about `/admin/users` matter more than the ones about `/directory/people`
 *
 * The new route is easy to get right and easy to check: it declares one read key. The risk this
 * phase actually carries runs the other way — that the pressure which produced it ("a document
 * controller cannot fill in a `USER` metadata field") gets relieved later by loosening
 * `/admin/users` instead, which would hand every holder of the read key the tenant's account
 * status, MFA enrolment, last sign-in and role membership.
 *
 * So the administrative declarations are asserted here, beside the thing that exists so they need
 * not change.
 *
 * The departments half of `/directory` is `organization/presentation/directory-permissions.spec.ts`
 * — two files because they are two modules and the boundary lint refuses a spec that reaches into
 * another module's internals, the same split `library-permissions.spec.ts` and `role-seed.spec.ts`
 * describe. Each names the other. The DTOs' half is `@edms/contracts`'s
 * `operations/read-models.spec.ts`.
 */

function declaredOn(target: object, method: string): readonly PermissionKey[] {
  const handler = (target as Record<string, unknown>)[method];
  return (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object) ??
    Reflect.getMetadata(REQUIRED_PERMISSIONS, target.constructor)) as readonly PermissionKey[];
}

describe('choosing a person requires directory:view and nothing else', () => {
  const directory = DirectoryPeopleController.prototype;

  it('gates the people list', () => {
    expect(declaredOn(directory, 'people')).toEqual([Permission.DIRECTORY_VIEW]);
  });

  it('demands no management grant', () => {
    // `RbacGuard` requires every declared permission, so a management key here would put the read
    // back behind the tenant administrator and restore the failure this phase removed.
    const declared = declaredOn(directory, 'people');
    expect(declared).not.toContain(Permission.USER_MANAGE);
    expect(declared).not.toContain(Permission.ROLE_MANAGE);
  });
});

describe('the administrative user routes are untouched', () => {
  const users = UserAdminController.prototype;

  it.each(['list', 'get', 'create', 'update', 'activate', 'disable', 'restore'])(
    'keeps %s on user:manage',
    (method) => {
      const declared = declaredOn(users, method);
      expect(declared).toEqual([Permission.USER_MANAGE]);
      // The whole point of the narrow route: `directory:view` must never reach the account record,
      // which carries the address, MFA enrolment, last sign-in, password state and role membership.
      expect(declared).not.toContain(Permission.DIRECTORY_VIEW);
    },
  );
});

describe('roles stay behind role:manage', () => {
  it('is not reachable with the new read key', () => {
    // Who holds which authority is not a picker. The ACL screen at `/documents/:id/permissions`
    // needs a role list and is a recorded follow-up, not something this phase quietly opens.
    const declared = declaredOn(RoleAdminController.prototype, 'list');
    expect(declared).toEqual([Permission.ROLE_MANAGE]);
    expect(declared).not.toContain(Permission.DIRECTORY_VIEW);
  });
});
