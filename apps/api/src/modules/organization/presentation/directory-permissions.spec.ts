import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { Permission, type PermissionKey } from '@edms/domain';

import { REQUIRED_PERMISSIONS } from '../../../core/authorization/permission.decorator';
import { DirectoryDepartmentsController } from './directory-read.controller';
import { OrganizationController } from './organization.controller';

/**
 * Choosing a department, and administering the organisation — two routes, two keys.
 *
 * `OrganizationController`'s own note is what this file makes enforceable: *"an organisation chart
 * names every department and every legal entity a customer has, which is not something every
 * authenticated caller should be able to enumerate. Later phases that need a department picker for
 * non-admins add a narrower endpoint rather than widening this one."*
 *
 * This is that phase, and the assertions below are in both directions: the narrow route declares
 * the read key, and every administrative route still declares `org:manage`. The second half is the
 * one worth having — the easy way to fix a `DEPARTMENT` metadata picker was always to soften the
 * guard on the endpoint that already existed.
 *
 * The people half of `/directory` is `identity/presentation/directory-permissions.spec.ts`; two
 * files because the boundary lint refuses a spec that reaches into another module's internals.
 */

function declaredOn(target: object, method: string): readonly PermissionKey[] {
  const handler = (target as Record<string, unknown>)[method];
  return (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object) ??
    Reflect.getMetadata(REQUIRED_PERMISSIONS, target.constructor)) as readonly PermissionKey[];
}

describe('choosing a department requires directory:view and nothing else', () => {
  it('gates the department list', () => {
    expect(declaredOn(DirectoryDepartmentsController.prototype, 'departments')).toEqual([
      Permission.DIRECTORY_VIEW,
    ]);
  });

  it('demands no management grant', () => {
    expect(declaredOn(DirectoryDepartmentsController.prototype, 'departments')).not.toContain(
      Permission.ORG_MANAGE,
    );
  });
});

describe('the administrative organisation routes are untouched', () => {
  const org = OrganizationController.prototype;

  it.each([
    'listCompanies',
    'listEntities',
    'listBranches',
    'listDepartments',
    'getDepartment',
    'createDepartment',
    'updateDepartment',
  ])('keeps %s on org:manage', (method) => {
    const declared = declaredOn(org, method);
    expect(declared).toEqual([Permission.ORG_MANAGE]);
    // `Department` carries entity and branch ancestry and a headcount per unit. The read key must
    // never reach it.
    expect(declared).not.toContain(Permission.DIRECTORY_VIEW);
  });
});
