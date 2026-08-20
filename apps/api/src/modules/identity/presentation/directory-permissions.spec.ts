import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { Permission, type PermissionKey, SystemRole } from '@edms/domain';

import { REQUIRED_PERMISSIONS } from '../../../core/authorization/permission.decorator';
import { DEFAULT_ROLE_PERMISSIONS } from '../domain/role-seed';
import { AclSubjectsController } from './acl-subjects.controller';
import { DelegationController } from './delegation.controller';
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
    // needs a role list — Slice 12 is the follow-up this line recorded, and it opened a *narrow*
    // route rather than this one.
    const declared = declaredOn(RoleAdminController.prototype, 'list');
    expect(declared).toEqual([Permission.ROLE_MANAGE]);
    expect(declared).not.toContain(Permission.DIRECTORY_VIEW);
    expect(declared).not.toContain(Permission.DOCUMENT_PERMISSION_MANAGE);
  });
});

/**
 * The follow-up the block above recorded, and the key it is on — Slice 12.
 *
 * An ACL entry may name a role, so the permission editor needs the tenant's roles as a picker sees
 * them. It used to read `/admin/roles`, behind `role:manage`, which the seeded document controller
 * does not hold — so the one role seeded with `document:permission:manage` got a 403 and the route
 * error boundary on the screen it exists to operate.
 *
 * The guard is the **operation's own key**, deliberately, and both halves of that are asserted
 * below. Not `role:manage`, or the defect stands. Not `directory:view` either: that key is
 * documented as *"the tenant's people and organisational units"*, a role is capability rather than
 * directory, and folding roles into it would broaden a permission this slice has no mandate to
 * broaden — the very move the `/admin/users` block above exists to prevent.
 */
describe('naming a role in an ACL entry requires the permission that writes one', () => {
  const acl = AclSubjectsController.prototype;

  it('gates the role options on document:permission:manage', () => {
    expect(declaredOn(acl, 'roleOptions')).toEqual([Permission.DOCUMENT_PERMISSION_MANAGE]);
  });

  it('demands no management grant, which is the whole point', () => {
    // `RbacGuard` requires every declared permission, so any of these here would put the picker
    // back behind the tenant administrator and restore the failure this slice removed.
    const declared = declaredOn(acl, 'roleOptions');
    for (const key of [
      Permission.ROLE_MANAGE,
      Permission.USER_MANAGE,
      Permission.ORG_MANAGE,
      Permission.SETTINGS_MANAGE,
    ]) {
      expect(declared).not.toContain(key);
    }
  });

  it('does not reach for directory:view either', () => {
    // Asserted as an absence rather than left unsaid: the cheap way to "fix" a future picker is to
    // add this key, and that is the broadening the catalogue entry forbids in words.
    expect(declaredOn(acl, 'roleOptions')).not.toContain(Permission.DIRECTORY_VIEW);
  });
});

/**
 * The same follow-up one screen further on — Slice 20.
 *
 * `/delegations` read `/admin/users` to fill its delegate picker. `delegation:manage` is seeded to
 * `AUTHOR`, `APPROVER` and `DOCUMENT_CONTROLLER` — the three roles `08-permission-model.md` §6
 * marks `own` for it — and **none of them holds `user:manage`**, so the screen that exists to
 * exercise the permission was openable only by the tenant administrator, the one role the matrix
 * does not mark `own`.
 *
 * The obvious repair was `/directory/people`, which returns the right shape already. It is the
 * wrong door, and `role-seed.spec.ts`'s *"no other seeded role receives the read keys"* is why:
 * reaching it means seeding `AUTHOR` and `APPROVER` a key that also opens `/directory/departments`,
 * which is a wider grant than delegation needs and a reversal of the previous slice's decision.
 *
 * So the guard is the operation's own key, and both halves are asserted — the key that is there,
 * and the four whose presence would put the picker back behind the tenant administrator.
 */
describe('naming a delegate requires the permission that writes a delegation', () => {
  const delegations = DelegationController.prototype;

  it('gates the delegate options on delegation:manage', () => {
    // Declared on the class rather than the handler, which `declaredOn` falls back to — the whole
    // controller carries the key, and the picker is inside that boundary rather than beside it.
    expect(declaredOn(delegations, 'delegates')).toEqual([Permission.DELEGATION_MANAGE]);
  });

  it('demands no management grant, which is the whole point', () => {
    const declared = declaredOn(delegations, 'delegates');
    for (const key of [
      Permission.USER_MANAGE,
      Permission.ROLE_MANAGE,
      Permission.ORG_MANAGE,
      Permission.SETTINGS_MANAGE,
    ]) {
      expect(declared).not.toContain(key);
    }
  });

  it('does not reach for directory:view either', () => {
    // Asserted as an absence rather than left unsaid: adding this key is the cheap way to "fix" a
    // future picker, and here it would also have needed two seeded roles widened to hold it.
    expect(declaredOn(delegations, 'delegates')).not.toContain(Permission.DIRECTORY_VIEW);
  });

  it('leaves the delegation writes on exactly the same key', () => {
    // The read is not a new boundary beside the writes; it is inside the one they already share.
    for (const method of ['list', 'request', 'declareEmergency', 'approve', 'decline', 'revoke']) {
      expect(declaredOn(delegations, method)).toEqual([Permission.DELEGATION_MANAGE]);
    }
  });
});

/**
 * The seeded roles this route has to be reachable by, read from the product's own seed.
 *
 * A declaration test proves what the guard asks for; this proves the three roles the matrix marks
 * `own` actually hold it, and that none of them holds what the route deliberately does not ask for.
 * Together they are the whole claim: the screen opens for `AUTHOR`, `APPROVER` and
 * `DOCUMENT_CONTROLLER` without any of them gaining a key.
 */
describe('the roles the delegation matrix marks own can reach the picker', () => {
  it.each([SystemRole.AUTHOR, SystemRole.APPROVER, SystemRole.DOCUMENT_CONTROLLER])(
    '%s holds delegation:manage and not user:manage',
    (role) => {
      const held = new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]);
      expect(held.has(Permission.DELEGATION_MANAGE)).toBe(true);
      expect(held.has(Permission.USER_MANAGE)).toBe(false);
    },
  );

  it.each([SystemRole.AUTHOR, SystemRole.APPROVER])(
    '%s still holds no directory:view, so the picker must not need one',
    (role) => {
      // The line that decides between the two possible fixes. If this ever becomes true, it will be
      // because somebody widened the seed rather than because the picker moved.
      expect(new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]).has(Permission.DIRECTORY_VIEW)).toBe(
        false,
      );
    },
  );

  it('leaves the auditor unable to reach it at all', () => {
    // It never held `delegation:manage` and gains nothing here; `/delegations` refuses it at the
    // page's own gate, and would refuse it at the route's.
    const auditor = new Set<string>(DEFAULT_ROLE_PERMISSIONS[SystemRole.AUDITOR]);
    expect(auditor.has(Permission.DELEGATION_MANAGE)).toBe(false);
  });
});
